import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyApiKey } from "@/lib/api-keys";
import { getDomainById } from "@/lib/domains";
import { query } from "@/lib/database";
import { sendEmailsSync } from "@/lib/batch-processor";

// Genuinely matches Resend's real /emails/batch contract (checked against
// resend.com/docs/api-reference/emails/send-batch-emails directly): the
// request body is a raw array (not wrapped in an object), capped at 100,
// processed synchronously, response is { data: [{ id }, ...] }. For large
// async sends (the thing Resend's own API has no answer for), see
// POST /api/emails/bulk instead — a deliberately different, non-Resend
// endpoint, not a variant of this one.

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

const batchEmailSchema = z
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
    reply_to: z.preprocess(toArrayOrString, z.array(z.string())).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine((data) => data.html || data.text, {
    message: "Either html or text content is required",
  });

// Raw array, not { emails: [...] } — matches Resend's real request shape.
const batchRequestSchema = z.array(batchEmailSchema).min(1).max(100, {
  message: "A maximum of 100 emails can be sent per batch request",
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
    const emails = batchRequestSchema.parse(body);

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
      `[/api/emails/batch] Sending batch of ${emails.length} emails for domain=${domain.domain}`
    );

    const results = await sendEmailsSync(
      emails.map((email) => {
        const toArray = Array.isArray(email.to) ? email.to : [email.to];
        const ccArray = email.cc
          ? Array.isArray(email.cc)
            ? email.cc
            : [email.cc]
          : undefined;
        const bccArray = email.bcc
          ? Array.isArray(email.bcc)
            ? email.bcc
            : [email.bcc]
          : undefined;
        const replyToArray = email.reply_to
          ? Array.isArray(email.reply_to)
            ? email.reply_to
            : [email.reply_to]
          : undefined;

        // Same contentType inference as the single-send route — schema
        // leaves it optional, EmailAttachment requires it.
        const attachments = email.attachments?.map((att) => {
          let contentType = att.contentType;
          if (!contentType) {
            if (att.filename.endsWith(".ics")) contentType = "text/calendar; method=REQUEST";
            else if (att.filename.endsWith(".pdf")) contentType = "application/pdf";
            else contentType = "application/octet-stream";
          }
          return { filename: att.filename, content: att.content, contentType };
        });

        return {
          from: email.from,
          to: toArray,
          cc: ccArray,
          bcc: bccArray,
          subject: email.subject,
          html: email.html,
          text: email.text,
          attachments,
          replyTo: replyToArray,
          tags: email.tags,
          headers: email.headers,
        };
      })
    );

    // Log each send — same email_logs table as the single-send route, no
    // batch_id (that's specific to the async /emails/bulk path).
    for (let i = 0; i < emails.length; i++) {
      const email = emails[i];
      const result = results[i];
      try {
        await query(
          `INSERT INTO email_logs (
            api_key_id, domain_id, from_email, to_emails, cc_emails, bcc_emails,
            subject, html_content, text_content, attachments, headers, status, ses_message_id, error_message
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            apiKey.id,
            domain.id,
            email.from,
            JSON.stringify(email.to),
            JSON.stringify(email.cc || []),
            JSON.stringify(email.bcc || []),
            email.subject,
            email.html,
            email.text,
            JSON.stringify(email.attachments || []),
            email.headers ? JSON.stringify(email.headers) : null,
            "id" in result ? "sent" : "failed",
            "id" in result ? result.id : null,
            "error" in result ? result.error : null,
          ]
        );
      } catch (logError) {
        console.error("Failed to log batch email:", logError);
      }
    }

    // Resend's real response shape: { data: [{ id }, ...] }.
    return cors(
      NextResponse.json({
        data: results.map((result) =>
          "id" in result ? { id: result.id } : { error: result.error }
        ),
      })
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
