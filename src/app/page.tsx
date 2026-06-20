import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import Marketing from "./_marketing/Marketing";

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
  title: "AskMai — Your taste, as an agent your followers can shop.",
  description:
    "AskMai builds a personal AI agent for creators. It knows your real taste, recommends real products with real links, and lives in your bio. Free to join. You earn on what your audience buys.",
};

export default function Home() {
  return (
    <div
      className={`${fraunces.variable} ${manrope.variable} askmai-landing`}
    >
      <Marketing />
    </div>
  );
}
