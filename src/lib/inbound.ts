import { createHmac } from "crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { simpleParser } from "mailparser";
import { query } from "@/lib/database";

const s3Client = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

/**
 * The SNS notification SES publishes when a receipt rule accepts a message.
 * Only the fields we actually read are typed — SES sends considerably more
 * (spam/virus/spf/dkim verdicts, full header array) and it all stays available
 * on the raw notification we log.
 */
export interface SESInboundNotification {
  notificationType: "Received";
  mail: {
    timestamp: string;
    source: string;
    messageId: string;
    destination: string[];
    commonHeaders?: {
      from?: string[];
      to?: string[];
      messageId?: string;
      subject?: string;
    };
  };
  receipt: {
    recipients: string[];
    action: {
      type: string;
      bucketName?: string;
      objectKey?: string;
    };
  };
}

export interface ParsedInboundEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
}

/**
 * Fetches the raw MIME SES dropped in S3 and parses it.
 *
 * The SNS notification itself carries only metadata — the S3 action is what
 * holds the body, which is why the receipt rule needs both. Attachments are
 * deliberately dropped in v1 (see the plan's scope section): the raw object
 * stays in S3 under raw_s3_key, so adding attachment support later is a
 * re-parse, not a re-receive.
 */
export async function fetchAndParseRawEmail(
  bucketName: string,
  objectKey: string,
): Promise<ParsedInboundEmail> {
  const response = await s3Client.send(
    new GetObjectCommand({ Bucket: bucketName, Key: objectKey }),
  );

  const raw = await response.Body!.transformToByteArray();
  const parsed = await simpleParser(Buffer.from(raw));

  // mailparser normalises addresses into objects; `to` can also be an array
  // when a message has multiple To headers.
  const toField = parsed.to;
  const toEntries = Array.isArray(toField) ? toField : toField ? [toField] : [];
  const to = toEntries.flatMap((entry) =>
    entry.value.map((addr) => addr.address ?? "").filter(Boolean),
  );

  // References arrives either as a string or an array depending on how many
  // ids the chain holds; the DB column keeps it raw and space-separated.
  const references = Array.isArray(parsed.references)
    ? parsed.references.join(" ")
    : parsed.references || null;

  return {
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references,
    from: parsed.from?.value[0]?.address || "",
    to,
    subject: parsed.subject || null,
    text: parsed.text || null,
    html: typeof parsed.html === "string" ? parsed.html : null,
  };
}

/**
 * Maps a recipient address back to the domains row that owns it. Mail arrives
 * on `<anything>@inbound.<domain>` (the MX generateDNSRecords() emits), while
 * domains.domain holds the root `<domain>` it was onboarded under — so the
 * `inbound.` label has to come off before the lookup.
 */
export async function findDomainForRecipient(
  recipient: string,
): Promise<{ id: string; domain: string; inbound_webhook_url: string | null; webhook_secret: string | null } | null> {
  const domainPart = recipient.split("@")[1]?.toLowerCase();
  if (!domainPart) return null;

  const rootDomain = domainPart.startsWith("inbound.")
    ? domainPart.slice("inbound.".length)
    : domainPart;

  const result = await query(
    "SELECT id, domain, inbound_webhook_url, webhook_secret FROM domains WHERE domain = $1 LIMIT 1",
    [rootDomain],
  );

  return result.rows[0] ?? null;
}

/**
 * Pushes a received email to the domain's configured inbound webhook.
 *
 * Deliberately deviates from real Resend's contract, which is metadata-only
 * and requires a follow-up retrieve call — that exists to dodge serverless
 * body-size limits with large attachments, and v1 has no attachments and no
 * such limit on the receiving app. Sending the parsed body inline makes this
 * one round trip instead of two. /api/emails/receiving/:id still exists for
 * contract parity and debugging.
 *
 * Signed with the same HMAC scheme and webhook_secret the sending-event
 * forwarder already uses, so a domain still only distributes one secret.
 */
export async function forwardReceivedEmail(
  receivedEmailId: string,
  domain: { id: string; inbound_webhook_url: string | null; webhook_secret: string | null },
  parsed: ParsedInboundEmail,
): Promise<void> {
  if (!domain.inbound_webhook_url || !domain.webhook_secret) {
    console.warn(
      `[forwardReceivedEmail] No inbound webhook configured for domain ${domain.id}; stored ${receivedEmailId} without forwarding`,
    );
    return;
  }

  const payload = {
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: receivedEmailId,
      message_id: parsed.messageId,
      in_reply_to: parsed.inReplyTo,
      references: parsed.references,
      from: parsed.from,
      to: parsed.to,
      subject: parsed.subject,
      text: parsed.text,
      html: parsed.html,
    },
  };

  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", domain.webhook_secret)
    .update(body)
    .digest("hex");

  let status = "failed";
  try {
    const response = await fetch(domain.inbound_webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": `sha256=${signature}`,
      },
      body,
    });

    status = response.ok ? "delivered" : `failed_${response.status}`;
    if (!response.ok) {
      const responseText = await response.text().catch(() => "(unreadable)");
      console.error(
        `[forwardReceivedEmail] Delivery failed: status=${response.status} url=${domain.inbound_webhook_url} email=${receivedEmailId} body="${responseText}"`,
      );
    } else {
      console.log(
        `[forwardReceivedEmail] Delivered received email ${receivedEmailId} → ${domain.inbound_webhook_url}`,
      );
    }
  } catch (error) {
    console.error(
      `[forwardReceivedEmail] Exception forwarding received email ${receivedEmailId}:`,
      error,
    );
  }

  await query(
    "UPDATE received_emails SET webhook_delivered_at = NOW(), webhook_delivery_status = $1 WHERE id = $2",
    [status, receivedEmailId],
  );
}
