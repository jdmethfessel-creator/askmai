/**
 * /forcreators — private pitch page.
 *
 * Unlisted (not linked from the public homepage, robots noindex). Sent
 * to creators directly. Built to feel like a premium product, not a
 * marketing template: the demo is the centerpiece (Mexico City travel
 * question rendering both restaurant picks and a shoppable packing
 * board — the gap-category demo that's the whole pitch).
 *
 * The displayed creator name on this page is the generic demo persona
 * "Hailey" (no real handle), so the pitch reads as a representative
 * example rather than a specific named creator. The underlying card
 * content and prose still come verbatim from real chat captures off
 * Madison's catalog — that's how we keep "no fabricated cards"
 * honest. Only the displayed creator name is anonymized for the
 * pitch context.
 */

import Link from "next/link";
import type { Metadata } from "next";
import DemoCarousel from "./DemoCarousel";
import "../_marketing/landing.css";
import "./forcreators.css";

export const metadata: Metadata = {
  title: "AskMai for Creators",
  description: "Your taste, working while you sleep.",
  robots: { index: false, follow: false, nocache: true },
};

export default function ForCreatorsPage() {
  return (
    <main className="askmai-landing fc-root">
      <NoiseLayer />
      <BackgroundGlow />

      {/* ----------- HERO ----------- */}
      <section className="fc-hero">
        <p className="fc-eyebrow">For creators</p>
        <h1 className="fc-hero-h1">
          Your taste, <em>working while you sleep.</em>
        </h1>
        <p className="fc-hero-body">
          You&apos;ve spent years building taste your followers trust. Right
          now it&apos;s scattered across expired story links and blog posts
          nobody can find. Your twin turns all of it into a single place your
          followers can ask anything, and shop everything, in your voice,
          instantly, forever.
        </p>
        <a href="#demo" className="fc-hero-cta">
          See your twin <ArrowRight />
        </a>
      </section>

      {/* ----------- DEMO (centerpiece) ----------- */}
      <section id="demo" className="fc-demo">
        <p className="fc-demo-label">real exchanges on Hailey&apos;s twin</p>
        <h2 className="fc-demo-h2">
          One link. <em>Travel, packing, beauty, fashion — all of it.</em>
        </h2>

        <DemoCarousel />

        <p className="fc-demo-caption">
          Try asking yours anything. Your Tulum hotel. Your go-to airport
          outfit. <em>The dress from that one post eight months ago.</em> It
          remembers everything you&apos;ve ever loved, and every answer is
          shoppable.
        </p>
      </section>

      {/* ----------- SHIFT (three contrasts) ----------- */}
      <section className="fc-shift">
        <p className="fc-shift-eyebrow">The shift</p>
        <h2 className="fc-shift-h2">
          What you couldn&apos;t do <em>before.</em>
        </h2>

        <div className="fc-contrasts">
          <div className="fc-contrast">
            <h3 className="fc-contrast-h3">
              Your best recommendations are buried.{" "}
              <em>Your twin surfaces them.</em>
            </h3>
            <p className="fc-contrast-body">
              That Mexico City guide you wrote? It&apos;s lost in a post from
              last spring. Your twin delivers it the second someone asks, no
              scrolling, no searching.
            </p>
          </div>

          <div className="fc-contrast">
            <h3 className="fc-contrast-h3">
              You recommend it once. <em>It sells forever.</em>
            </h3>
            <p className="fc-contrast-body">
              No more re-linking the same pieces in every story. Your twin
              keeps your whole catalog live and shoppable, around the clock.
            </p>
          </div>

          <div className="fc-contrast">
            <h3 className="fc-contrast-h3">
              You can&apos;t reply to 50,000 followers. <em>Your twin can.</em>
            </h3>
            <p className="fc-contrast-body">
              In your voice, while you sleep, with a real answer and a real
              product for every single one.
            </p>
          </div>
        </div>
      </section>

      {/* ----------- MONEY ----------- */}
      <section className="fc-money">
        <p className="fc-money-eyebrow">The money</p>
        <h2 className="fc-money-h2">
          The revenue your current setup <em>can&apos;t reach.</em>
        </h2>
        <p className="fc-money-body">
          Keep your LTK and ShopMy links exactly as they are, nothing changes,
          nothing to relearn. Your twin makes them work harder by surfacing
          them on demand instead of letting them expire in your feed.
        </p>
        <p className="fc-money-body">
          Then it opens the doors those platforms keep shut. The hotels you
          stayed at. The restaurants you booked. The experiences your
          followers constantly ask about and you can&apos;t currently
          monetize. Your twin turns your travel and lifestyle taste — the
          stuff that&apos;s pure word-of-mouth today — into a revenue stream
          that&apos;s been sitting on the table this whole time.
        </p>
        <p className="fc-money-punch">
          Most of your influence is unmonetized right now.{" "}
          <em>Your twin changes that.</em>
        </p>
      </section>

      {/* ----------- HOW IT WORKS ----------- */}
      <section className="fc-how">
        <p className="fc-how-eyebrow">How it works</p>
        <h2 className="fc-how-h2">Effortless on your end.</h2>
        <ol className="fc-steps">
          <li className="fc-step">
            <p className="fc-step-body">
              <strong>Connect your existing affiliate accounts.</strong> Five
              minutes.
            </p>
          </li>
          <li className="fc-step">
            <p className="fc-step-body">
              <strong>We build your twin,</strong> trained on your taste and
              your voice.
            </p>
          </li>
          <li className="fc-step">
            <p className="fc-step-body">
              <strong>You share one link.</strong> Your followers do the rest.
            </p>
          </li>
        </ol>
      </section>

      {/* ----------- CLOSE ----------- */}
      <section className="fc-close">
        <h2 className="fc-close-h2">
          Your twin is <em>already possible.</em> Let&apos;s build yours.
        </h2>
        <Link href="/creator-signup" className="fc-close-cta">
          Get early access <ArrowRight />
        </Link>
        <p className="fc-close-sub">
          We&apos;re onboarding a small group of creators now.
        </p>
      </section>

      <footer className="fc-footer">AskMai · For Creators</footer>
    </main>
  );
}

/* ---------- atmospherics + icons ---------- */

function NoiseLayer() {
  return (
    <svg className="lp-noise" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <filter id="fc-noise-filter">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.85"
          numOctaves="2"
          stitchTiles="stitch"
        />
        <feColorMatrix
          values="0 0 0 0 0.95
                  0 0 0 0 0.91
                  0 0 0 0 0.84
                  0 0 0 0.55 0"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#fc-noise-filter)" />
    </svg>
  );
}

function BackgroundGlow() {
  return (
    <div className="lp-glow" aria-hidden>
      <div className="lp-glow-a" />
      <div className="lp-glow-b" />
    </div>
  );
}

function ArrowRight() {
  return (
    <svg
      className="fc-arrow"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

