import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { query } from "@/lib/database";

interface SESMessage {
  eventType: "send" | "delivery" | "bounce" | "complaint" | "reject";
  mail: {
    messageId: string;
    timestamp: string;
    source: string;
    destination: string[];
  };
  delivery?: {
    timestamp: string;
    processingTimeMillis: number;
    recipients: string[];
    smtpResponse: string;
  };
  bounce?: {
    bounceType: string;
    bounceSubType: string;
    bouncedRecipients: Array<{
      emailAddress: string;
      action: string;
      status: string;
      diagnosticCode: string;
    }>;
    timestamp: string;
    feedbackId: string;
  };
  complaint?: {
    complainedRecipients: Array<{
      emailAddress: string;
    }>;
    timestamp: string;
    feedbackId: string;
    complaintFeedbackType: string;
  };
}

async function handleSESWebhook(req: NextRequest) {
  try {
    const body = await req.json();

    // Handle SNS confirmation
    if (body.Type === "SubscriptionConfirmation") {
      console.log("SNS Subscription confirmation received");
      // You would typically confirm the subscription here
      return NextResponse.json({ message: "Subscription confirmed" });
    }

    // Handle SNS notification
    if (body.Type === "Notification") {
      const message: SESMessage = JSON.parse(body.Message);

      await processSESEvent(message);

      return NextResponse.json({ message: "Event processed" });
    }

    return NextResponse.json({ message: "Unknown event type" });
  } catch (error) {
    console.error("SES webhook error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

async function processSESEvent(message: SESMessage) {
  try {
    // Find the email log by SES message ID
    const emailResult = await query(
      "SELECT * FROM email_logs WHERE ses_message_id = $1 LIMIT 1",
      [message.mail.messageId]
    );

    if (emailResult.rows.length === 0) {
      console.warn(
        `Email log not found for message ID: ${message.mail.messageId}`
      );
      return;
    }

    const emailLog = {
      ...emailResult.rows[0],
      to_emails: JSON.parse(emailResult.rows[0].to_emails || "[]"),
      cc_emails: JSON.parse(emailResult.rows[0].cc_emails || "[]"),
      bcc_emails: JSON.parse(emailResult.rows[0].bcc_emails || "[]"),
      attachments: JSON.parse(emailResult.rows[0].attachments || "[]"),
    };

    // Update email status based on event type
    let newStatus = emailLog.status;
    let errorMessage = null;

    switch (message.eventType) {
      case "delivery":
        newStatus = "delivered";
        break;
      case "bounce":
        newStatus = "bounced";
        errorMessage = message.bounce?.bouncedRecipients
          .map((r) => `${r.emailAddress}: ${r.diagnosticCode}`)
          .join("; ");
        break;
      case "complaint":
        newStatus = "complained";
        errorMessage = `Complaint from: ${message.complaint?.complainedRecipients
          .map((r) => r.emailAddress)
          .join(", ")}`;
        break;
      case "reject":
        newStatus = "failed";
        errorMessage = "Email rejected by SES";
        break;
    }

    // Update email log status
    await query(
      `UPDATE email_logs 
       SET status = $1, error_message = $2, webhook_data = $3
       WHERE id = $4`,
      [newStatus, errorMessage, JSON.stringify(message), emailLog.id]
    );

    // Create webhook event record
    await query(
      `INSERT INTO webhook_events (email_log_id, event_type, event_data, processed)
       VALUES ($1, $2, $3, $4)`,
      [emailLog.id, message.eventType, JSON.stringify(message), true]
    );

    await forwardEventToApp(emailLog, message);

    console.log(
      `Processed ${message.eventType} event for email ${emailLog.id}`
    );
  } catch (error) {
    console.error("Failed to process SES event:", error);

    // Create unprocessed webhook event for manual review
    try {
      await query(
        `INSERT INTO webhook_events (email_log_id, event_type, event_data, processed)
         VALUES ($1, $2, $3, $4)`,
        [null, message.eventType, JSON.stringify(message), false]
      );
    } catch (insertError) {
      console.error("Failed to create webhook event record:", insertError);
    }
  }
}

async function forwardEventToApp(
  emailLog: { id: string; domain_id: string; from_email: string; to_emails: string[] },
  message: SESMessage
) {
  try {
    const domainResult = await query(
      "SELECT webhook_url, webhook_secret FROM domains WHERE id = $1",
      [emailLog.domain_id]
    );

    const { webhook_url, webhook_secret } = domainResult.rows[0] ?? {};
    if (!webhook_url || !webhook_secret) return;

    // Map SES event type to Resend-compatible event type
    const typeMap: Record<string, string> = {
      delivery: "email.delivered",
      bounce: "email.bounced",
      complaint: "email.bounced",
      reject: "email.failed",
    };
    const resendType = typeMap[message.eventType];
    if (!resendType) return;

    // Determine bounce type for bounce events
    let bounceData: { type: string } | undefined;
    if (message.eventType === "bounce") {
      bounceData = {
        type: message.bounce?.bounceType === "Permanent" ? "Permanent" : "Transient",
      };
    } else if (message.eventType === "complaint") {
      bounceData = { type: "Permanent" };
    }

    const payload = {
      type: resendType,
      data: {
        id: emailLog.id,
        from: emailLog.from_email,
        to: emailLog.to_emails,
        created_at: new Date().toISOString(),
        ...(bounceData && { bounce: bounceData }),
      },
    };

    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", webhook_secret).update(body).digest("hex");

    console.log(`[forwardEventToApp] Forwarding ${message.eventType} (email ${emailLog.id}) → ${webhook_url}`);
    const fwdResponse = await fetch(webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-signature": `sha256=${signature}`,
      },
      body,
    });

    if (!fwdResponse.ok) {
      const responseText = await fwdResponse.text().catch(() => "(unreadable)");
      console.error(
        `[forwardEventToApp] Webhook delivery failed: status=${fwdResponse.status} url=${webhook_url} email=${emailLog.id} body="${responseText}"`
      );
    } else {
      console.log(`[forwardEventToApp] Webhook delivered: status=${fwdResponse.status} email=${emailLog.id}`);
    }
  } catch (error) {
    console.error(`[forwardEventToApp] Exception forwarding ${message.eventType} event for email ${emailLog.id}:`, error);
  }
}

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
    const result = await handleSESWebhook(request);
    return cors(result);
  } catch (error) {
    console.error("API Error:", error);
    return cors(NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    ));
  }
}
