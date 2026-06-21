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
  title: "AskMai",
  description:
    "Each creator gets a branded AI twin that knows their real taste and recommends real products, with real links.",
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
