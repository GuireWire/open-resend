import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyApiKey } from "@/lib/api-keys";
import { getDomainById } from "@/lib/domains";
import { transaction } from "@/lib/database";
import { processBatch } from "@/lib/batch-processor";

// Not part of Resend's real API — Resend's own /emails/batch is synchronous
// and capped at 100 (see /api/emails/batch in this app for that genuinely
// compatible endpoint). This one exists because Resend has no answer for
// "send to 10,000 recipients" — a single HTTP request can't stay open that
// long. Async: returns a bulkId immediately, processes in the background,
// poll GET /api/emails/bulk/:id for status. Still stored in the `batches`
// table internally (unchanged name, this is just the route surface).

const bufferObject = z.object({
  type: z.literal("Buffer"),
  data: z.array(z.number()),
});

const attachmentContent = z
  .union([z.string(), bufferObject])
  .transform((val) =>
    typeof val === "string" ? val : Buffer.from(val.data).toString("base64")
  );

const attachmentSchema = z.object({
  filename: z.string(),
  content: attachmentContent,
  contentType: z.string().optional(),
});

const toArrayOrString = (val: unknown) =>
  typeof val === "string" ? [val] : val;

const bulkEmailSchema = z
  .object({
    from: z.string().min(1, "From is required"),
    to: z.preprocess(
      toArrayOrString,
      z.array(z.string()).min(1, "At least one recipient is required")
    ),
    cc: z.preprocess(toArrayOrString, z.array(z.string())).optional(),
    bcc: z.preprocess(toArrayOrString, z.array(z.string())).optional(),
    subject: z.string().min(1, "Subject is required"),
    html: z.string().optional(),
    text: z.string().optional(),
    attachments: z.array(attachmentSchema).optional(),
  })
  .refine((data) => data.html || data.text, {
    message: "Either html or text content is required",
  });

const bulkRequestSchema = z.object({
  emails: z.array(bulkEmailSchema).min(1).max(1000),
});

function cors(response: NextResponse) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  response.headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
  return response;
}

export async function POST(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return cors(new NextResponse(null, { status: 200 }));
  }

  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return cors(
        NextResponse.json(
          { error: "Missing authorization header" },
          { status: 401 }
        )
      );
    }

    const apiKeyValue = authHeader.substring(7);
    const apiKey = await verifyApiKey(apiKeyValue);
    if (!apiKey) {
      return cors(
        NextResponse.json({ error: "Invalid API key" }, { status: 401 })
      );
    }

    if (!apiKey.permissions.includes("send")) {
      return cors(
        NextResponse.json(
          { error: "API key does not have send permission" },
          { status: 403 }
        )
      );
    }

    const body = await request.json();
    const { emails } = bulkRequestSchema.parse(body);

    const domain = await getDomainById(apiKey.domain_id);
    if (!domain) {
      return cors(
        NextResponse.json({ error: "Domain not found" }, { status: 404 })
      );
    }
    if (domain.status !== "verified") {
      return cors(
        NextResponse.json({ error: "Domain not verified" }, { status: 400 })
      );
    }

    for (const email of emails) {
      const fromEmail = email.from.includes("<")
        ? email.from.split("<")[1].replace(">", "").trim()
        : email.from.trim();
      const fromDomain = fromEmail.split("@")[1];
      if (fromDomain !== domain.domain) {
        return cors(
          NextResponse.json(
            {
              error: `From email must be from domain: ${domain.domain}`,
            },
            { status: 400 }
          )
        );
      }
    }

    console.log(
      `[/api/emails/bulk] Queuing bulk send of ${emails.length} emails for domain=${domain.domain}`
    );

    const bulkId = await transaction(async (client) => {
      const batchResult = await client.query(
        `INSERT INTO batches (api_key_id, domain_id, total_count, status)
         VALUES ($1, $2, $3, 'pending')
         RETURNING id`,
        [apiKey.id, domain.id, emails.length]
      );
      const id = batchResult.rows[0].id;

      for (const email of emails) {
        await client.query(
          `INSERT INTO email_logs (
            api_key_id, domain_id, batch_id, from_email, to_emails, cc_emails, bcc_emails,
            subject, html_content, text_content, attachments, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending')`,
          [
            apiKey.id,
            domain.id,
            id,
            email.from,
            JSON.stringify(email.to),
            JSON.stringify(email.cc || []),
            JSON.stringify(email.bcc || []),
            email.subject,
            email.html,
            email.text,
            JSON.stringify(email.attachments || []),
          ]
        );
      }

      return id;
    });

    // Fire and forget — this is a long-running Node process (Docker/standalone,
    // not serverless), so processing continues after the response is sent.
    // Errors here are per-item (caught + recorded inside processBatch) or a
    // total processor crash, which we still don't want to leave silent.
    processBatch(bulkId).catch((error) => {
      console.error(`[bulk ${bulkId}] Processing failed:`, error);
    });

    return cors(
      NextResponse.json(
        { bulkId, total: emails.length, status: "pending" },
        { status: 202 }
      )
    );
  } catch (error: unknown) {
    const errorObj = error as { errors?: unknown; message?: string };
    if (
      errorObj.errors ||
      errorObj.message?.includes("validation") ||
      errorObj.message?.includes("parse")
    ) {
      return cors(
        NextResponse.json(
          {
            error: "Invalid request data",
            details: errorObj.errors || errorObj.message,
          },
          { status: 400 }
        )
      );
    }

    console.error("API Error:", error);
    return cors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 })
    );
  }
}
