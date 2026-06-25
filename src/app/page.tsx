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

export const metadata: Metadata = {
  title: "AskMai",
  description:
    "Each creator gets a branded AI twin that knows their real taste and recommends real products, with real links.",
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
