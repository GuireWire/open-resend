import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/database";
import {
  fetchAndParseRawEmail,
  findDomainForRecipient,
  forwardReceivedEmail,
  type ParsedInboundEmail,
  type SESInboundNotification,
} from "@/lib/inbound";

/**
 * Inbound (received) email webhook.
 *
 * Kept separate from /api/webhooks/ses — that one handles SES *sending* events
 * (delivery/bounce/complaint/reject) and gets an entirely different SNS payload
 * shape. Same separation of concerns as /api/emails vs /batch vs /bulk.
 *
 * Wire-up: an SES Receipt Rule with an S3 action (raw MIME → bucket) whose
 * topicArn points at an SNS topic subscribed to this URL.
 */

function cors(response: NextResponse) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return response;
}

/**
 * Optional shared secret, passed as ?token= on the SNS subscription URL. SNS
 * itself signs its messages, but verifying that signature means fetching and
 * caching AWS's signing certs — this is the cheap guard, and without it the
 * endpoint accepts an unauthenticated POST from anyone who learns the URL.
 * Unset = open, matching the existing sending-events webhook's behaviour.
 */
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.SES_INBOUND_WEBHOOK_TOKEN;
  if (!expected) return true;
  return request.nextUrl.searchParams.get("token") === expected;
}

async function confirmSubscription(body: {
  SubscribeURL?: string;
  TopicArn?: string;
}) {
  if (!body.SubscribeURL) {
    console.error("[ses-inbound] SubscriptionConfirmation with no SubscribeURL");
    return;
  }

  // Only auto-confirm topics we expect, when the expectation is configured —
  // otherwise anyone able to reach this endpoint could have it confirm a
  // subscription to a topic they control.
  const expectedTopic = process.env.SES_INBOUND_TOPIC_ARN;
  if (expectedTopic && body.TopicArn !== expectedTopic) {
    console.error(
      `[ses-inbound] Refusing to confirm unexpected topic: ${body.TopicArn}`,
    );
    return;
  }

  const response = await fetch(body.SubscribeURL);
  console.log(
    `[ses-inbound] Subscription confirmation for ${body.TopicArn}: status=${response.status}`,
  );
}

async function processInboundEmail(notification: SESInboundNotification) {
  const recipients = notification.receipt?.recipients ?? notification.mail.destination ?? [];

  // A single message can be addressed to several of our recipients; the domain
  // is what matters, and every recipient in one rule shares it in practice.
  // First match wins, and an unknown domain is dropped rather than stored
  // against a null domain_id we could never route.
  let domain = null;
  for (const recipient of recipients) {
    domain = await findDomainForRecipient(recipient);
    if (domain) break;
  }

  if (!domain) {
    console.warn(
      `[ses-inbound] No matching domain for recipients: ${JSON.stringify(recipients)} — dropping`,
    );
    return;
  }

  const { bucketName, objectKey } = notification.receipt.action;

  let parsed: ParsedInboundEmail;
  if (bucketName && objectKey) {
    parsed = await fetchAndParseRawEmail(bucketName, objectKey);
  } else {
    // No S3 action on the rule — SES still gives us the envelope and common
    // headers, which is enough to correlate a reply even without a body.
    // Worth storing (and alerting on) rather than silently discarding.
    console.error(
      `[ses-inbound] Receipt action has no S3 object (type=${notification.receipt.action.type}); storing headers only`,
    );
    parsed = {
      messageId: notification.mail.commonHeaders?.messageId ?? null,
      inReplyTo: null,
      references: null,
      from: notification.mail.source,
      to: recipients,
      subject: notification.mail.commonHeaders?.subject ?? null,
      text: null,
      html: null,
    };
  }

  const result = await query(
    `INSERT INTO received_emails (
      domain_id, message_id, in_reply_to, references_header,
      from_email, to_emails, subject, text_content, html_content, raw_s3_key
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING id`,
    [
      domain.id,
      parsed.messageId,
      parsed.inReplyTo,
      parsed.references,
      parsed.from,
      JSON.stringify(parsed.to.length > 0 ? parsed.to : recipients),
      parsed.subject,
      parsed.text,
      parsed.html,
      objectKey ?? null,
    ],
  );

  const receivedEmailId = result.rows[0].id;
  console.log(
    `[ses-inbound] Stored received email ${receivedEmailId} from=${parsed.from} domain=${domain.domain} inReplyTo=${parsed.inReplyTo}`,
  );

  await forwardReceivedEmail(receivedEmailId, domain, parsed);
}

export async function POST(request: NextRequest) {
  if (request.method === "OPTIONS") {
    return cors(new NextResponse(null, { status: 200 }));
  }

  if (!isAuthorized(request)) {
    return cors(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
  }

  try {
    const body = await request.json();

    if (body.Type === "SubscriptionConfirmation") {
      await confirmSubscription(body);
      return cors(NextResponse.json({ message: "Subscription confirmed" }));
    }

    if (body.Type === "Notification") {
      const notification: SESInboundNotification = JSON.parse(body.Message);

      if (notification.notificationType !== "Received") {
        console.warn(
          `[ses-inbound] Ignoring non-Received notification: ${notification.notificationType}`,
        );
        return cors(NextResponse.json({ message: "Ignored" }));
      }

      await processInboundEmail(notification);
      return cors(NextResponse.json({ message: "Email processed" }));
    }

    return cors(NextResponse.json({ message: "Unknown event type" }));
  } catch (error) {
    console.error("[ses-inbound] Webhook error:", error);
    return cors(
      NextResponse.json({ error: "Internal server error" }, { status: 500 }),
    );
  }
}

export async function OPTIONS() {
  return cors(new NextResponse(null, { status: 200 }));
}
