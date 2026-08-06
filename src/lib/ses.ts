import {
  SESClient,
  SendEmailCommand,
  SendRawEmailCommand,
  VerifyDomainIdentityCommand,
  GetIdentityVerificationAttributesCommand,
  DeleteIdentityCommand,
  CreateConfigurationSetCommand,
  VerifyDomainDkimCommand,
  GetIdentityDkimAttributesCommand,
  GetSendQuotaCommand,
} from "@aws-sdk/client-ses";

const sesClient = new SESClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType: string;
}

export interface SendEmailOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: EmailAttachment[];
  replyTo?: string[];
  tags?: Record<string, string>;
  // Custom email headers (e.g. List-Unsubscribe/List-Unsubscribe-Post for
  // RFC 8058 one-click unsubscribe). SES's plain SendEmailCommand has no
  // field for arbitrary headers — only SendRawEmailCommand's raw MIME does,
  // so any headers here force that path, same as attachments already do.
  headers?: Record<string, string>;
}

export interface SESVerificationResult {
  verificationToken: string;
  status: "Pending" | "Success" | "Failed" | "TemporaryFailure" | "NotStarted";
}

export async function sendEmail(options: SendEmailOptions): Promise<string> {
  const { from, to, cc, bcc, subject, html, text, replyTo, tags } = options;

  if (
    (options.attachments && options.attachments.length > 0) ||
    (options.headers && Object.keys(options.headers).length > 0)
  ) {
    // Use raw email for attachments or custom headers — SendEmailCommand
    // supports neither.
    return sendRawEmail(options);
  }

  const command = new SendEmailCommand({
    Source: from,
    Destination: {
      ToAddresses: to,
      CcAddresses: cc,
      BccAddresses: bcc,
    },
    Message: {
      Subject: {
        Data: subject,
        Charset: "UTF-8",
      },
      Body: {
        Html: html
          ? {
              Data: html,
              Charset: "UTF-8",
            }
          : undefined,
        Text: text
          ? {
              Data: text,
              Charset: "UTF-8",
            }
          : undefined,
      },
    },
    ReplyToAddresses: replyTo,
    Tags: tags
      ? Object.entries(tags).map(([Name, Value]) => ({ Name, Value }))
      : undefined,
  });

  const response = await sesClient.send(command);
  return response.MessageId!;
}

// RFC 5322 header values must be 7-bit ASCII with no bare CR/LF. Two
// separate concerns folded into one helper since both apply to every header
// value written into the raw MIME text below: (1) non-ASCII (accents,
// emoji, non-Latin scripts — plausible in a shop-owner-typed subject line
// or display name) technically needs RFC 2047 encoded-word wrapping, or the
// header is malformed even though most clients tolerate raw UTF-8 in
// practice; (2) a bare CR/LF in a value that's just string-concatenated
// into the message would inject arbitrary extra headers/body content.
function encodeHeaderValue(value: string): string {
  const sanitized = value.replace(/[\r\n]/g, "");
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(sanitized)) return sanitized;
  return `=?UTF-8?B?${Buffer.from(sanitized, "utf-8").toString("base64")}?=`;
}

// Encodes only the display-name portion of a `"Name" <email@domain>` (or
// bare `email@domain`) address string — the address itself must stay
// ASCII/punycode, only the free-text display name can contain anything.
function encodeAddressHeader(address: string): string {
  const match = address.match(/^(.*?)(<[^>]+>)\s*$/);
  if (!match) return encodeHeaderValue(address);
  const [, namePart, angleAddr] = match;
  const name = namePart.trim().replace(/^"|"$/g, "");
  if (!name) return angleAddr;
  const encoded = encodeHeaderValue(name);
  return encoded === name ? `"${name}" ${angleAddr}` : `${encoded} ${angleAddr}`;
}

// Header names a caller can never set via the generic `headers` option —
// each already has its own dedicated, validated field (from/to/cc/bcc/
// subject/replyTo), or is structural to the MIME message itself. Without
// this, a caller could use `headers` as a bypass — e.g. a "Bcc" entry here
// would silently add a recipient outside the validated to/cc/bcc fields.
const FORBIDDEN_HEADER_NAMES = new Set(
  [
    "from",
    "to",
    "cc",
    "bcc",
    "subject",
    "reply-to",
    "mime-version",
    "content-type",
    "content-transfer-encoding",
    "dkim-signature",
  ].map((n) => n.toLowerCase()),
);

// Header NAMES were never validated (only values were CRLF-stripped/
// encoded above) — a caller-supplied name containing ":\r\n" would splice
// an arbitrary extra header into the raw MIME text just as effectively as
// an unsanitized value would. `headers` is public API surface (any API key
// holder can POST arbitrary names to /api/emails, /batch, /bulk), so this
// has to be enforced at the one place every path funnels through, not left
// to whatever validation a given caller happens to do upstream.
function assertValidHeaderName(name: string): void {
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
    throw new Error(`Invalid header name: ${JSON.stringify(name)}`);
  }
  if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
    throw new Error(
      `Header "${name}" must be set via its dedicated field, not headers`,
    );
  }
}

export async function sendRawEmail(options: SendEmailOptions): Promise<string> {
  const {
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    attachments = [],
    replyTo,
  } = options;

  // Build raw email
  const boundary = `----=_NextPart_${Date.now()}_${Math.random().toString(36)}`;
  const recipients = [...to, ...(cc || []), ...(bcc || [])];

  let rawMessage = "";

  // Headers
  rawMessage += `From: ${encodeAddressHeader(from)}\r\n`;
  rawMessage += `To: ${to.map(encodeAddressHeader).join(", ")}\r\n`;
  if (cc && cc.length > 0)
    rawMessage += `Cc: ${cc.map(encodeAddressHeader).join(", ")}\r\n`;
  if (replyTo && replyTo.length > 0)
    rawMessage += `Reply-To: ${replyTo.map(encodeAddressHeader).join(", ")}\r\n`;
  rawMessage += `Subject: ${encodeHeaderValue(subject)}\r\n`;
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    assertValidHeaderName(name);
    rawMessage += `${name}: ${encodeHeaderValue(value)}\r\n`;
  }
  rawMessage += `MIME-Version: 1.0\r\n`;
  rawMessage += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;

  // Body parts
  rawMessage += `--${boundary}\r\n`;
  rawMessage += `Content-Type: multipart/alternative; boundary="${boundary}-alt"\r\n\r\n`;

  if (text) {
    rawMessage += `--${boundary}-alt\r\n`;
    rawMessage += `Content-Type: text/plain; charset=UTF-8\r\n\r\n`;
    rawMessage += `${text}\r\n\r\n`;
  }

  if (html) {
    rawMessage += `--${boundary}-alt\r\n`;
    rawMessage += `Content-Type: text/html; charset=UTF-8\r\n\r\n`;
    rawMessage += `${html}\r\n\r\n`;
  }

  rawMessage += `--${boundary}-alt--\r\n`;

  // Attachments
  for (const attachment of attachments) {
    rawMessage += `--${boundary}\r\n`;
    rawMessage += `Content-Type: ${attachment.contentType}\r\n`;
    rawMessage += `Content-Disposition: attachment; filename="${attachment.filename}"\r\n`;
    rawMessage += `Content-Transfer-Encoding: base64\r\n\r\n`;
    rawMessage += `${attachment.content}\r\n`;
  }

  rawMessage += `--${boundary}--\r\n`;

  const command = new SendRawEmailCommand({
    Source: from,
    Destinations: recipients,
    RawMessage: {
      Data: new TextEncoder().encode(rawMessage),
    },
  });

  const response = await sesClient.send(command);
  return response.MessageId!;
}

export async function verifyDomain(
  domain: string
): Promise<SESVerificationResult> {
  const command = new VerifyDomainIdentityCommand({
    Domain: domain,
  });

  const response = await sesClient.send(command);

  return {
    verificationToken: response.VerificationToken!,
    status: "Pending",
  };
}

export async function getDomainVerificationStatus(
  domain: string
): Promise<string> {
  const command = new GetIdentityVerificationAttributesCommand({
    Identities: [domain],
  });

  const response = await sesClient.send(command);
  const attributes = response.VerificationAttributes?.[domain];

  return attributes?.VerificationStatus || "NotStarted";
}

export async function enableDomainDkim(domain: string): Promise<string[]> {
  const command = new VerifyDomainDkimCommand({
    Domain: domain,
  });

  const response = await sesClient.send(command);
  return response.DkimTokens || [];
}

export async function getDomainDkimTokens(domain: string): Promise<string[]> {
  const command = new GetIdentityDkimAttributesCommand({
    Identities: [domain],
  });

  const response = await sesClient.send(command);
  const attributes = response.DkimAttributes?.[domain];

  return attributes?.DkimTokens || [];
}

export async function deleteDomainIdentity(domain: string): Promise<void> {
  const command = new DeleteIdentityCommand({
    Identity: domain,
  });

  await sesClient.send(command);
}

export async function createConfigurationSet(domain: string): Promise<string> {
  const configSetName = `freeresend-${domain.replace(/\./g, "-")}`;

  try {
    const command = new CreateConfigurationSetCommand({
      ConfigurationSet: {
        Name: configSetName,
      },
    });

    await sesClient.send(command);

    return configSetName;
  } catch (error: unknown) {
    const awsError = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    // Handle various ways AWS might indicate the configuration set already exists
    if (
      awsError.name === "AlreadyExistsException" ||
      awsError.name === "ConfigurationSetAlreadyExistsException" ||
      awsError.message?.includes("already exists") ||
      awsError.message?.includes("Configuration set") ||
      awsError.$metadata?.httpStatusCode === 409
    ) {
      console.log(
        `Configuration set ${configSetName} already exists, continuing...`
      );
      return configSetName;
    }
    console.error("SES Configuration Set Error:", error);
    throw error;
  }
}

export function generateDNSRecords(
  domain: string,
  verificationToken: string,
  dkimTokens: string[] = []
) {
  const records = [
    {
      type: "TXT",
      name: `_amazonses.${domain}`,
      value: verificationToken,
      ttl: 300,
      description: "SES Domain Verification",
    },
    {
      type: "MX",
      name: `inbound.${domain}`,
      value: `10 inbound-smtp.${process.env.AWS_REGION || "us-east-1"}.amazonaws.com.`, // Trailing dot required by Digital Ocean
      ttl: 300,
      description: "SES Inbound Email (receives at inbound.yourdomain.com - avoids conflict with existing MX)",
    },
    {
      type: "TXT",
      name: domain,
      value: "v=spf1 include:amazonses.com ~all",
      ttl: 300,
      description: "SPF Record for SES",
    },
    {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: "v=DMARC1; p=quarantine; rua=mailto:dmarc@" + domain,
      ttl: 300,
      description: "DMARC Policy",
    },
  ];

  // Add DKIM CNAME records
  dkimTokens.forEach((token) => {
    records.push({
      type: "CNAME",
      name: `${token}._domainkey.${domain}`,
      value: `${token}.dkim.amazonses.com.`, // Trailing dot required
      ttl: 300,
      description: `DKIM Record (${token.substring(0, 8)}...)`,
    });
  });

  return records;
}

export interface SendQuota {
  max24HourSend: number;
  maxSendRate: number;
  sentLast24Hours: number;
}

// Used by the batch sender to pace itself against the account's real
// approved SES rate instead of guessing/hardcoding one.
export async function getSendQuota(): Promise<SendQuota> {
  const command = new GetSendQuotaCommand({});
  const response = await sesClient.send(command);
  return {
    max24HourSend: response.Max24HourSend ?? 0,
    maxSendRate: response.MaxSendRate ?? 1,
    sentLast24Hours: response.SentLast24Hours ?? 0,
  };
}
