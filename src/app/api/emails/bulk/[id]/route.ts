import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey } from "@/lib/api-keys";
import { query } from "@/lib/database";

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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params;

    const batchResult = await query(
      `SELECT id, domain_id, total_count, sent_count, failed_count, status, created_at, updated_at
       FROM batches WHERE id = $1 LIMIT 1`,
      [id]
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      return cors(
        NextResponse.json({ error: "Bulk send not found" }, { status: 404 })
      );
    }

    // Scope to the requesting API key's own domain — same ownership model
    // as GET /api/emails/:id, just keyed on domain rather than api_key_id
    // since a bulk send can be polled by any key belonging to that domain.
    if (batch.domain_id !== apiKey.domain_id) {
      return cors(
        NextResponse.json({ error: "Bulk send not found" }, { status: 404 })
      );
    }

    const itemsResult = await query(
      `SELECT id, to_emails, status, ses_message_id, error_message
       FROM email_logs WHERE batch_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    return cors(
      NextResponse.json({
        bulkId: batch.id,
        status: batch.status,
        total: batch.total_count,
        sent: batch.sent_count,
        failed: batch.failed_count,
        pending: batch.total_count - batch.sent_count - batch.failed_count,
        createdAt: batch.created_at,
        updatedAt: batch.updated_at,
        items: itemsResult.rows.map((row) => ({
          id: row.id,
          to: row.to_emails,
          status: row.status,
          messageId: row.ses_message_id,
          error: row.error_message,
        })),
      })
    );
  } catch (error: unknown) {
    console.error("API Error:", error);
    return cors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 })
    );
  }
}
