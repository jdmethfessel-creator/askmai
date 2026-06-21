import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://askmai.co"),
  title: {
    default: "AskMai",
    template: "%s · AskMai",
  },
  description:
    "Each creator gets a branded AI agent that knows their real taste and recommends real products, with real links.",
  applicationName: "AskMai",
  openGraph: {
    title: "AskMai",
    description:
      "Each creator gets a branded AI agent that knows their real taste and recommends real products, with real links.",
    siteName: "AskMai",
    type: "website",
  },
};

const SKIMLINKS_PUBLISHER_ID = process.env.SKIMLINKS_PUBLISHER_ID;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh">
        {children}
        {SKIMLINKS_PUBLISHER_ID && (
          // Secondary monetization: Skimlinks JS auto-affiliates merchant
          // links in the DOM. Server-side links built via generateAggregatorLink
          // are already Skimlinks-wrapped; this catches anything that renders
          // as a plain merchant link (e.g. inside conversational text).
          // Feed-tier anchors carry className="noskim" so this script ignores
          // them and never overwrites our existing affiliate URLs.
          <Script
            src={`https://s.skimresources.com/js/${SKIMLINKS_PUBLISHER_ID}.skimlinks.js`}
            strategy="afterInteractive"
          />
        )}
      </body>
    </html>
  );
}
