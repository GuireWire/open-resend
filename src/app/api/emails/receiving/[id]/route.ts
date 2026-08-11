import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey } from "@/lib/api-keys";
import { query } from "@/lib/database";

/**
 * Retrieve a received email — mirrors real Resend's "Retrieve received email".
 *
 * Not required by the v1 booking-reply flow: /api/webhooks/ses-inbound pushes
 * the full parsed body inline, so the receiving app never has to come back for
 * it. Exists for contract parity and for debugging a reply that threaded wrong
 * (and it's where attachment retrieval would land if v1's no-attachments scope
 * is ever lifted).
 */

function cors(response: NextResponse) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return response;
}

function safeParseArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as string[];
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
  return [];
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (request.method === "OPTIONS") {
    return cors(new NextResponse(null, { status: 200 }));
  }

  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return cors(
        NextResponse.json({ error: "Missing authorization header" }, { status: 401 }),
      );
    }

    const apiKey = await verifyApiKey(authHeader.substring(7));
    if (!apiKey) {
      return cors(NextResponse.json({ error: "Invalid API key" }, { status: 401 }));
    }

    const { id } = await params;

    // Scoped to the key's own domain — that scoping *is* the authorization.
    // Deliberately not gated behind a new "receive" permission: existing keys
    // are all created with ["send"] only, so adding one would lock out every
    // already-onboarded domain for no security gain over the domain scope.
    const result = await query(
      `SELECT id, domain_id, message_id, in_reply_to, references_header,
              from_email, to_emails, subject, text_content, html_content,
              raw_s3_key, received_at, webhook_delivered_at, webhook_delivery_status
       FROM received_emails
       WHERE id = $1 AND domain_id = $2
       LIMIT 1`,
      [id, apiKey.domain_id],
    );

    if (result.rows.length === 0) {
      return cors(
        NextResponse.json({ error: "Received email not found" }, { status: 404 }),
      );
    }

    const row = result.rows[0];

    return cors(
      NextResponse.json({
        id: row.id,
        message_id: row.message_id,
        in_reply_to: row.in_reply_to,
        references: row.references_header,
        from: row.from_email,
        to: safeParseArray(row.to_emails),
        subject: row.subject,
        text: row.text_content,
        html: row.html_content,
        // No attachments in v1 — the raw MIME is retained in S3 so support can
        // be added later without needing the message re-sent.
        attachments: [],
        created_at: row.received_at,
      }),
    );
  } catch (error) {
    console.error("API Error:", error);
    return cors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 }),
    );
  }
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 200 }));
}
