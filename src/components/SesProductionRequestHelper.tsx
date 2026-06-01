"use client";

import { FormEvent, useMemo, useState } from "react";
import { Check, Clipboard, ExternalLink, FileText, ShieldCheck } from "lucide-react";
import { deploymentReview, launchKit } from "@/config/launch-kit";
import { buildSesProductionRequest, type SesProductionRequestInput } from "@/lib/ses-production-request";

const initialInput: SesProductionRequestInput = {
  sendingDomain: "",
  websiteUrl: "",
  region: "us-east-1",
  useCase: "",
  expectedVolume: "",
  optInSource: "",
  bounceHandling: "",
  complaintHandling: "",
};

export default function SesProductionRequestHelper() {
  const [input, setInput] = useState<SesProductionRequestInput>(initialInput);
  const [submittedInput, setSubmittedInput] = useState<SesProductionRequestInput | null>(null);
  const [copied, setCopied] = useState<"subject" | "body" | null>(null);

  const request = useMemo(
    () => buildSesProductionRequest(submittedInput ?? input),
    [input, submittedInput]
  );

  function updateInput(field: keyof SesProductionRequestInput, value: string) {
    setInput((current) => ({ ...current, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmittedInput(input);
  }

  async function copyText(kind: "subject" | "body", value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1800);
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="grid gap-8 lg:grid-cols-[0.92fr_1.08fr] lg:items-start">
        <form onSubmit={handleSubmit} className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
            <FileText className="h-6 w-6" />
          </div>
          <h1 className="text-3xl font-bold leading-tight text-gray-900 sm:text-4xl">
            SES production request helper
          </h1>
          <p className="mt-4 leading-7 text-gray-600">
            Draft the Amazon SES production access request from public rollout details before a FreeResend launch.
          </p>

          <div className="mt-7 grid gap-4">
            <Field
              id="sendingDomain"
              label="Sending domain"
              placeholder="example.com"
              value={input.sendingDomain}
              onChange={(value) => updateInput("sendingDomain", value)}
              required
            />
            <Field
              id="websiteUrl"
              label="Website or app URL"
              placeholder="https://example.com"
              value={input.websiteUrl}
              onChange={(value) => updateInput("websiteUrl", value)}
            />
            <Field
              id="region"
              label="AWS region"
              placeholder="us-east-1"
              value={input.region}
              onChange={(value) => updateInput("region", value)}
              required
            />
            <TextArea
              id="useCase"
              label="Use case"
              placeholder="Password resets, login codes, invoices, and account notifications"
              value={input.useCase}
              onChange={(value) => updateInput("useCase", value)}
            />
            <Field
              id="expectedVolume"
              label="Expected volume"
              placeholder="2,000 messages per month with gradual ramp-up"
              value={input.expectedVolume}
              onChange={(value) => updateInput("expectedVolume", value)}
            />
            <TextArea
              id="optInSource"
              label="Recipient opt-in/source"
              placeholder="Only registered users who request account email"
              value={input.optInSource}
              onChange={(value) => updateInput("optInSource", value)}
            />
            <TextArea
              id="bounceHandling"
              label="Bounce handling"
              placeholder="SNS webhook into FreeResend bounce handler"
              value={input.bounceHandling}
              onChange={(value) => updateInput("bounceHandling", value)}
            />
            <TextArea
              id="complaintHandling"
              label="Complaint handling"
              placeholder="SNS complaint webhook with suppression"
              value={input.complaintHandling}
              onChange={(value) => updateInput("complaintHandling", value)}
            />
          </div>

          <button
            type="submit"
            className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 font-semibold text-white transition-colors hover:bg-indigo-700"
          >
            <FileText className="h-4 w-4" />
            <span>Generate request</span>
          </button>

          <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            Do not paste AWS keys, SMTP passwords, customer lists, private logs, or customer data into this tool.
          </div>
        </form>

        <div className="space-y-5">
          <article className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-wide text-indigo-700">Draft output</p>
                <h2 className="mt-2 text-2xl font-bold text-gray-900">{request.subject}</h2>
              </div>
              <button
                type="button"
                onClick={() => copyText("subject", request.subject)}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                {copied === "subject" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
                <span>Copy subject</span>
              </button>
            </div>
            <pre className="mt-5 max-h-[560px] overflow-auto whitespace-pre-wrap rounded-lg border border-gray-100 bg-gray-950 p-4 text-sm leading-6 text-gray-100">
              {request.body}
            </pre>
            <button
              type="button"
              onClick={() => copyText("body", request.body)}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-gray-800"
            >
              {copied === "body" ? <Check className="h-4 w-4" /> : <Clipboard className="h-4 w-4" />}
              <span>Copy request body</span>
            </button>
          </article>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6">
            <div className="flex gap-3">
              <ShieldCheck className="mt-1 h-5 w-5 flex-none text-emerald-700" />
              <div>
                <h2 className="text-xl font-bold text-emerald-950">Want the rollout checked first?</h2>
                <p className="mt-2 leading-7 text-emerald-900">
                  The {deploymentReview.price} Deployment Review covers SES sandbox status, region choice, DNS, webhook
                  handling, and smoke-test gaps before you send production traffic.
                </p>
              </div>
            </div>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <a
                href={deploymentReview.checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white transition-colors hover:bg-emerald-700"
              >
                <span>Book deployment review</span>
                <ExternalLink className="h-4 w-4" />
              </a>
              <a
                href={launchKit.checkoutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-white px-5 py-3 font-semibold text-emerald-800 transition-colors hover:bg-emerald-100"
              >
                <span>Buy launch kit</span>
                <ExternalLink className="h-4 w-4" />
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Field({
  id,
  label,
  placeholder,
  value,
  onChange,
  required = false,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold text-gray-900">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        className="mt-2 w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      />
    </div>
  );
}

function TextArea({
  id,
  label,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-semibold text-gray-900">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        rows={3}
        className="mt-2 w-full resize-y rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
      />
    </div>
  );
}
