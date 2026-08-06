import { query } from "@/lib/database";
import {
  sendEmail,
  getSendQuota,
  type EmailAttachment,
  type SendEmailOptions,
} from "@/lib/ses";

// Stay under the account's approved rate rather than right at it — leaves
// headroom for other sends happening on the same account concurrently.
const SAFETY_FACTOR = 0.8;

// Used by the genuinely Resend-compatible POST /api/emails/batch (small,
// ≤100, synchronous — matches Resend's real contract) — not the pacing
// used by processBatch below, which is for the large async /emails/bulk
// path. A bounded 100-item burst with modest concurrency is a much smaller
// reputation risk than pacing thousands of sequential sends would be, and
// real Resend doesn't rate-limit-throttle within a single batch call either.
const SYNC_CONCURRENCY = 5;

export async function sendEmailsSync(
  emails: SendEmailOptions[],
): Promise<Array<{ id: string } | { error: string }>> {
  const results: Array<{ id: string } | { error: string }> = new Array(
    emails.length,
  );
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < emails.length) {
      const current = nextIndex++;
      try {
        const id = await sendEmail(emails[current]);
        results[current] = { id };
      } catch (error) {
        results[current] = {
          error: error instanceof Error ? error.message : "Failed to send email",
        };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(SYNC_CONCURRENCY, emails.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

interface PendingEmailLogRow {
  id: string;
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  bcc_emails: string[];
  subject: string;
  html_content: string | null;
  text_content: string | null;
  attachments: EmailAttachment[];
  headers: Record<string, string> | null;
}

// Processes every still-pending email_logs row for a batch, paced against
// the AWS account's real Maximum Send Rate (auto-discovered, not guessed).
// Safe to call again on a partially-completed batch — only picks up rows
// still marked 'pending', so a server restart mid-batch just resumes here.
export async function processBatch(batchId: string): Promise<void> {
  await query(`UPDATE batches SET status = 'processing' WHERE id = $1`, [
    batchId,
  ]);

  const { rows } = await query(
    `SELECT id, from_email, to_emails, cc_emails, bcc_emails, subject, html_content, text_content, attachments, headers
     FROM email_logs
     WHERE batch_id = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [batchId]
  );

  let maxSendRate = 1;
  try {
    const quota = await getSendQuota();
    maxSendRate = quota.maxSendRate;
  } catch (error) {
    console.error(
      `[batch ${batchId}] Failed to fetch SES send quota, falling back to 1/sec`,
      error
    );
  }
  const minIntervalMs = Math.ceil(1000 / (maxSendRate * SAFETY_FACTOR));

  const { rows: countRows } = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
       COUNT(*) FILTER (WHERE status = 'failed') AS failed_count
     FROM email_logs WHERE batch_id = $1`,
    [batchId]
  );
  let sent = parseInt(countRows[0]?.sent_count ?? "0", 10);
  let failed = parseInt(countRows[0]?.failed_count ?? "0", 10);

  for (const row of rows as PendingEmailLogRow[]) {
    const start = Date.now();
    try {
      const messageId = await sendEmail({
        from: row.from_email,
        to: row.to_emails,
        cc: row.cc_emails?.length ? row.cc_emails : undefined,
        bcc: row.bcc_emails?.length ? row.bcc_emails : undefined,
        subject: row.subject,
        html: row.html_content ?? undefined,
        text: row.text_content ?? undefined,
        attachments: row.attachments?.length ? row.attachments : undefined,
        headers: row.headers ?? undefined,
      });
      await query(
        `UPDATE email_logs SET status = 'sent', ses_message_id = $1 WHERE id = $2`,
        [messageId, row.id]
      );
      sent++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await query(
        `UPDATE email_logs SET status = 'failed', error_message = $1 WHERE id = $2`,
        [message, row.id]
      );
      failed++;
    }

    await query(
      `UPDATE batches SET sent_count = $1, failed_count = $2 WHERE id = $3`,
      [sent, failed, batchId]
    );

    const remaining = minIntervalMs - (Date.now() - start);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  await query(`UPDATE batches SET status = 'completed' WHERE id = $1`, [
    batchId,
  ]);
}
