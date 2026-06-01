import type { Metadata } from "next";
import Link from "next/link";
import SesProductionRequestHelper from "@/components/SesProductionRequestHelper";
import { deploymentReview, launchKit, sesProductionGuide, sesRequestHelper } from "@/config/launch-kit";

export const metadata: Metadata = {
  title: "SES Production Request Helper",
  description:
    "Draft a safe Amazon SES production access request for a FreeResend launch without sharing secrets or customer data.",
  alternates: {
    canonical: sesRequestHelper.canonicalUrl,
  },
  openGraph: {
    title: "SES Production Request Helper",
    description: "Generate a reviewer-friendly SES production access request from public rollout details.",
    url: sesRequestHelper.canonicalUrl,
    type: "website",
  },
};

export default function SesProductionRequestHelperPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-emerald-50">
      <div className="border-b border-gray-100 bg-white/80 backdrop-blur-sm">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-sm font-semibold text-gray-700 hover:text-gray-950">
            FreeResend
          </Link>
          <div className="flex items-center gap-4 text-sm font-medium">
            <Link href={launchKit.productUrl} className="text-gray-600 hover:text-gray-950">
              Launch Kit
            </Link>
            <Link href="/tools/email-dns-checker" className="text-gray-600 hover:text-gray-950">
              DNS
            </Link>
            <Link href={sesProductionGuide.productUrl} className="text-gray-600 hover:text-gray-950">
              Guide
            </Link>
            <Link href={deploymentReview.productUrl} className="text-gray-600 hover:text-gray-950">
              Review
            </Link>
          </div>
        </nav>
      </div>
      <SesProductionRequestHelper />
    </main>
  );
}
