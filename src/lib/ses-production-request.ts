export type SesProductionRequestInput = {
  sendingDomain: string;
  websiteUrl: string;
  region: string;
  useCase: string;
  expectedVolume: string;
  optInSource: string;
  bounceHandling: string;
  complaintHandling: string;
};

export type SesProductionRequest = {
  subject: string;
  body: string;
};

const defaults = {
  websiteUrl: "Not provided",
  region: "us-east-1",
  useCase: "Transactional application email",
  expectedVolume: "Low initial production volume with gradual ramp-up",
  optInSource: "Only opted-in or account-related recipients",
  bounceHandling: "Amazon SNS bounce notifications routed to the application suppression workflow",
  complaintHandling: "Amazon SNS complaint notifications routed to suppression and follow-up review",
};

function clean(value: string | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function cleanDomain(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^@/, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

export function normalizeSesProductionRequestInput(input: SesProductionRequestInput): SesProductionRequestInput {
  return {
    sendingDomain: cleanDomain(input.sendingDomain),
    websiteUrl: clean(input.websiteUrl, defaults.websiteUrl),
    region: clean(input.region, defaults.region),
    useCase: clean(input.useCase, defaults.useCase),
    expectedVolume: clean(input.expectedVolume, defaults.expectedVolume),
    optInSource: clean(input.optInSource, defaults.optInSource),
    bounceHandling: clean(input.bounceHandling, defaults.bounceHandling),
    complaintHandling: clean(input.complaintHandling, defaults.complaintHandling),
  };
}

export function buildSesProductionRequest(input: SesProductionRequestInput): SesProductionRequest {
  const normalized = normalizeSesProductionRequestInput(input);
  const subject = `Request production access for Amazon SES in ${normalized.region}`;
  const body = [
    "Hello AWS SES team,",
    "",
    "I am requesting production access for Amazon SES so this account can send transactional email through a self-hosted FreeResend deployment.",
    "",
    `Sending domain: ${normalized.sendingDomain}`,
    `Website or app URL: ${normalized.websiteUrl}`,
    `AWS region: ${normalized.region}`,
    `Use case: ${normalized.useCase}`,
    `Expected volume: ${normalized.expectedVolume}`,
    `Recipient opt-in/source: ${normalized.optInSource}`,
    `Bounce handling: ${normalized.bounceHandling}`,
    `Complaint handling: ${normalized.complaintHandling}`,
    "",
    "Operational controls:",
    "- SPF, DKIM, and DMARC will be configured before production sending.",
    "- Bounces and complaints will be monitored and suppressed before additional sends.",
    "- Mailing lists will not be purchased, scraped, or imported from unverified sources.",
    "- Sending will start at low volume and ramp only after delivery and complaint rates are healthy.",
    "",
    "I am not including AWS access keys, SMTP passwords, or customer data in this request.",
    "",
    "Thank you.",
  ].join("\n");

  return { subject, body };
}
