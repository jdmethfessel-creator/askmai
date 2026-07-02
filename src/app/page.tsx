import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import Marketing from "./_marketing/Marketing";
import { getServerSession } from "@/lib/session";

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-display",
});

const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});

const OG_TITLE = "AskMai";
const OG_DESC =
  "Try on your favorite creator's actual closet. See it on you before you buy.";
const OG_IMAGE = "/og/home.png";

export const metadata: Metadata = {
  title: OG_TITLE,
  description: OG_DESC,
  openGraph: {
    title: OG_TITLE,
    description: OG_DESC,
    url: "https://www.askmai.co/",
    type: "website",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: OG_TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: OG_DESC,
    images: [OG_IMAGE],
  },
};

// The page reads the auth cookie via getServerSession so the nav
// renders correctly on first paint — no client-side flash between
// "Log in" and "Signed in."
export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getServerSession();
  return (
    <div
      className={`${fraunces.variable} ${manrope.variable} askmai-landing`}
    >
      <Marketing signedIn={Boolean(session)} />
    </div>
  );
}
