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
  title: "Launch your AskMai twin",
  description:
    "Drop your affiliate links and a few words about how you write. Your AskMai twin goes live in about a minute.",
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
            <p className="lp-eyebrow">Launch</p>
            <h1 className="signup-h1">
              Your AI twin,{" "}
              <span className="lp-accent-ink">live in a minute.</span>
            </h1>
            <p className="signup-sub">
              Drop your affiliate links and a few hundred words in
              your own voice. We pull your catalog, generate your AI
              twin, and publish your page automatically. You&apos;ll
              get a live URL and an edit link in the response — no
              waiting on us.
            </p>

            <SignupForm />
          </div>
        </section>
      </main>
    </div>
  );
}
