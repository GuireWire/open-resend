import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyApiKey } from "@/lib/api-keys";
import { sendEmail } from "@/lib/ses";
import { getDomainById } from "@/lib/domains";
import { query } from "@/lib/database";

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

const sendEmailSchema = z
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
  })
  .refine((data) => data.html || data.text, {
    message: "Either html or text content is required",
  });

function cors(response: NextResponse) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return response;
}

export async function POST(request: NextRequest) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return cors(new NextResponse(null, { status: 200 }));
  }

  try {
    // Check authorization (API key required)
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return cors(NextResponse.json(
        { error: "Missing authorization header" },
        { status: 401 }
      ));
    }

    const apiKeyValue = authHeader.substring(7);
    const apiKey = await verifyApiKey(apiKeyValue);
    if (!apiKey) {
      console.error("[/api/emails] Invalid API key:", apiKeyValue.substring(0, 12) + "...");
      return cors(NextResponse.json(
        { error: "Invalid API key" },
        { status: 401 }
      ));
    }

    // Parse and validate request body
    const body = await request.json();
    const validatedData = sendEmailSchema.parse(body);

    const {
      from,
      to,
      cc,
      bcc,
      subject,
      html,
      text,
      attachments,
      reply_to,
      tags,
    } = validatedData;

    console.log(`[/api/emails] Sending email from=${from} to=${JSON.stringify(to)} subject="${subject}" attachments=${attachments?.length ?? 0}`);

    // Verify the from domain is authorized for this API key
    const domain = await getDomainById(apiKey.domain_id);
    if (!domain) {
      console.error("[/api/emails] Domain not found for api_key domain_id:", apiKey.domain_id);
      return cors(NextResponse.json({ error: "Domain not found" }, { status: 404 }));
    }

    if (domain.status !== "verified") {
      console.error("[/api/emails] Domain not verified:", domain.domain, "status:", domain.status);
      return cors(NextResponse.json(
        { error: "Domain not verified" },
        { status: 400 }
      ));
    }

    // Validate from email domain — handle both plain and display name formats
    const fromEmail = from.includes("<")
      ? from.split("<")[1].replace(">", "").trim()
      : from.trim();
    const fromDomain = fromEmail.split("@")[1];
    if (fromDomain !== domain.domain) {
      console.error(`[/api/emails] From domain mismatch: got "${fromDomain}", expected "${domain.domain}"`);
      return cors(NextResponse.json(
        { error: `From email must be from domain: ${domain.domain}` },
        { status: 400 }
      ));
    }

    // Check API key permissions
    if (!apiKey.permissions.includes("send")) {
      console.error("[/api/emails] API key missing send permission:", apiKey.permissions);
      return cors(NextResponse.json(
        { error: "API key does not have send permission" },
        { status: 403 }
      ));
    }

    // Convert arrays and prepare data for SES
    const toArray = Array.isArray(to) ? to : [to];
    const ccArray = cc ? (Array.isArray(cc) ? cc : [cc]) : undefined;
    const bccArray = bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : undefined;
    const replyToArray = reply_to ? (Array.isArray(reply_to) ? reply_to : [reply_to]) : undefined;
    
    // Convert attachments to match EmailAttachment interface
    const sesAttachments = attachments?.map(att => {
      let contentType = att.contentType;
      if (!contentType) {
        if (att.filename.endsWith('.ics')) contentType = 'text/calendar; method=REQUEST';
        else if (att.filename.endsWith('.pdf')) contentType = 'application/pdf';
        else contentType = 'application/octet-stream';
      }
      return { filename: att.filename, content: att.content, contentType };
    });

    // Send email via SES
    const messageId = await sendEmail({
      from,
      to: toArray,
      cc: ccArray,
      bcc: bccArray,
      subject: subject || '',
      html,
      text,
      attachments: sesAttachments,
      replyTo: replyToArray,
      tags,
    });

    // Log email in database
    let emailLog = null;
    try {
      const result = await query(
        `INSERT INTO email_logs (
          api_key_id, domain_id, from_email, to_emails, cc_emails, bcc_emails,
          subject, html_content, text_content, attachments, status, ses_message_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING *`,
        [
          apiKey.id,
          domain.id,
          from,
          JSON.stringify(to),
          JSON.stringify(cc || []),
          JSON.stringify(bcc || []),
          subject,
          html,
          text,
          JSON.stringify(attachments || []),
          "sent",
          messageId,
        ]
      );
      emailLog = result.rows[0];
    } catch (logError) {
      console.error("Failed to log email:", logError);
    }

    return cors(NextResponse.json({
      id: emailLog?.id || messageId,
      from,
      to,
      created_at: new Date().toISOString(),
    }));
  } catch (error: unknown) {
    // Handle validation errors
    const errorObj = error as { errors?: unknown; message?: string };
    if (errorObj.errors || errorObj.message?.includes('validation') || errorObj.message?.includes('parse')) {
      return cors(NextResponse.json(
        {
          error: "Invalid request data",
          details: errorObj.errors || errorObj.message,
        },
        { status: 400 }
      ));
    }

    console.error("API Error:", error);
    return cors(NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    ));
  }
}