import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://askmai.co"),
  title: {
    default: "AskMai",
    template: "%s · AskMai",
  },
  description:
    "Every creator's voice, taste, and real picks in one chat. With real shoppable links.",
  applicationName: "AskMai",
  openGraph: {
    title: "AskMai",
    description:
      "Every creator's voice, taste, and real picks in one chat. With real shoppable links.",
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
