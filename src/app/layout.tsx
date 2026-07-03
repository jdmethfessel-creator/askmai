import type { Metadata } from "next";
import { Bodoni_Moda, Space_Grotesk, Caveat } from "next/font/google";
import "./globals.css";

const bodoniModa = Bodoni_Moda({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["400", "500", "600", "700", "800"],
  style: ["normal", "italic"],
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
  weight: ["400", "500", "600", "700"],
});

const caveat = Caveat({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hand",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://askmai.co"),
  title: {
    default: "AskMai",
    template: "%s · AskMai",
  },
  description:
    "The closet is open. Shop every piece, ask Mai anything, and see it on you before you buy.",
  applicationName: "AskMai",
  openGraph: {
    title: "AskMai",
    description:
      "The closet is open. Shop every piece, ask Mai anything, and see it on you before you buy.",
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
    <html
      lang="en"
      className={`${bodoniModa.variable} ${spaceGrotesk.variable} ${caveat.variable}`}
    >
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
