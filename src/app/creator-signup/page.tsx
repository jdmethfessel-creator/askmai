import type { Metadata } from "next";
import { Fraunces, Manrope } from "next/font/google";
import Link from "next/link";
import "../_marketing/landing.css";
import "./signup.css";
import { SignupForm } from "./SignupForm";

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
  title: "Apply — AskMai",
  description:
    "Apply to get an AskMai twin. Lead-capture for creator interest; we onboard approved creators manually.",
};

export const dynamic = "force-dynamic";

export default function CreatorSignupPage() {
  return (
    <div className={`${fraunces.variable} ${manrope.variable} askmai-landing`}>
      <main className="lp-root">
        <header className="lp-nav">
          <Link
            href="/"
            className="lp-wordmark"
            style={{ textDecoration: "none", color: "inherit" }}
          >
            ask<em>mai</em>
          </Link>
          <nav className="lp-nav-right">
            <Link href="/" className="lp-nav-link">
              Home
            </Link>
          </nav>
        </header>

        <section className="signup-section">
          <div className="signup-inner">
            <p className="lp-eyebrow">Apply</p>
            <h1 className="signup-h1">
              Get your{" "}
              <span className="lp-accent-ink">AskMai twin.</span>
            </h1>
            <p className="signup-sub">
              Tell us where to find you. We&apos;re onboarding a small
              group of creators by hand and will reach out personally
              once we&apos;ve had a look at your feed.
            </p>

            <SignupForm />
          </div>
        </section>
      </main>
    </div>
  );
}
