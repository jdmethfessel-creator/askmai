import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://askmai.co"),
  title: {
    default: "AskMai",
    template: "%s · AskMai",
  },
  description:
    "Each creator gets a branded AI twin that knows their real taste and recommends real products, with real links.",
  applicationName: "AskMai",
  openGraph: {
    title: "AskMai",
    description:
      "Each creator gets a branded AI twin that knows their real taste and recommends real products, with real links.",
    siteName: "AskMai",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
