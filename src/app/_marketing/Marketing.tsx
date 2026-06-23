"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import "./landing.css";

// Stub the waitlist endpoint until we wire Formspree. The form fakes a
// successful submit so the visual flow is testable; swap WAITLIST_ENDPOINT
// for a real Formspree URL when ready.
const WAITLIST_ENDPOINT = "";

const VALUE_PILLARS: { title: string; body: string }[] = [
  {
    title: "Scale the affiliate you already have",
    body: "Your LTK and ShopMy links, now conversational. Your twin recommends in your voice and links what you already monetize, working for your audience around the clock.",
  },
  {
    title: "Earn on what you couldn't before",
    body: "Travel, hotels, restaurants, experiences. The categories LTK and ShopMy don't cover. Earn on the recommendations you were already making for free.",
  },
  {
    title: "Be there for every follower at once",
    body: "Your audience talks to your twin instead of scrolling past a link. A real conversation in your voice, available to every follower at the same time.",
  },
  {
    title: "Drop exclusive recs",
    body: "Give your twin picks and knowledge that live nowhere else. Your audience gets a you they can't find on any other platform.",
  },
];

const FEATURES: { kicker: string; title: string; body: string }[] = [
  {
    kicker: "01",
    title: "Knows your real taste.",
    body: "Built from your actual style, not a generic recommender. Your taste profile, your voice, your brands. Trained the way a friend who's followed you for years would answer.",
  },
  {
    kicker: "02",
    title: "Real products, real links.",
    body: "Every recommendation is a shoppable item your followers can buy. Real merchant URLs, real prices, real images. Not a wishlist screenshot. Not a vague vibe.",
  },
  {
    kicker: "03",
    title: "Lives in your bio.",
    body: "askmai.co/yourhandle. Your name. Your face. Your colors. Not a marketplace where you're one of a thousand. The page belongs to you.",
  },
  {
    kicker: "04",
    title: "You stay in control.",
    body: "Brands can't buy a recommendation you wouldn't make. Your taste profile, your rules. We never put words in your mouth or push products that don't fit.",
  },
];

export default function Marketing() {
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<
    "idle" | "sending" | "done" | "error"
  >("idle");

  // Scroll-triggered reveals.
  const observerRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            (e.target as HTMLElement).dataset.in = "1";
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "-12% 0px", threshold: 0.05 }
    );
    observerRef.current = io;
    document
      .querySelectorAll("[data-reveal]")
      .forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@")) return;
    setSubmitState("sending");
    try {
      if (WAITLIST_ENDPOINT) {
        await fetch(WAITLIST_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ email, source: "askmai-landing" }),
        });
      } else {
        await new Promise((r) => setTimeout(r, 600));
      }
      setSubmitState("done");
    } catch {
      setSubmitState("error");
    }
  }

  return (
    <main className="lp-root">
      <NoiseLayer />
      <BackgroundGlow />

      <header className="lp-nav">
        <span className="lp-wordmark">
          ask<em>mai</em>
        </span>
        <nav className="lp-nav-right">
          <Link href="/creators" className="lp-nav-link">
            Creators
          </Link>
          <a href="#waitlist" className="lp-nav-cta">
            Get your twin
          </a>
        </nav>
      </header>

      {/* ---------- HERO ---------- */}
      <section className="lp-hero">
        <p className="lp-eyebrow lp-fade-in" style={{ animationDelay: "80ms" }}>
          AskMai · for creators
        </p>
        <h1 className="lp-hero-h1">
          <span className="lp-line lp-fade-in" style={{ animationDelay: "180ms" }}>
            Your shoppable AI
          </span>{" "}
          <span
            className="lp-line lp-fade-in lp-accent-ink"
            style={{ animationDelay: "320ms" }}
          >
            digital twin
          </span>
        </h1>

        <p
          className="lp-sub lp-fade-in"
          style={{ animationDelay: "620ms" }}
        >
          Each creator gets a branded AI twin that knows their real taste and
          recommends real products with real links, from their own bio.
        </p>

        <div className="lp-cta-row lp-fade-in" style={{ animationDelay: "760ms" }}>
          <a href="#waitlist" className="lp-btn lp-btn-primary">
            Get your twin
            <ArrowRight />
          </a>
          <Link href="/creators" className="lp-btn lp-btn-ghost">
            Talk to creators
            <ArrowRight subtle />
          </Link>
        </div>

        <div className="lp-marquee" aria-hidden>
          <div className="lp-marquee-track">
            {[
              "Ask",
              "Discover",
              "Style",
              "Shop",
              "Book",
              "Pack",
              "Plan",
              "Pair",
              "Source",
              "Find",
            ]
              .concat([
                "Ask",
                "Discover",
                "Style",
                "Shop",
                "Book",
                "Pack",
                "Plan",
                "Pair",
                "Source",
                "Find",
              ])
              .map((w, i) => (
                <span key={i} className="lp-marquee-word">
                  {w}
                  <span className="lp-marquee-dot">·</span>
                </span>
              ))}
          </div>
        </div>
      </section>

      {/* ---------- LIVE PROOF ---------- */}
      <section className="lp-live" data-reveal>
        <div className="lp-live-grid">
          <div className="lp-live-copy">
            <p className="lp-eyebrow">Live now</p>
            <h2 className="lp-h2">
              Danielle Bernstein&apos;s twin is{" "}
              <span className="lp-accent-ink">live.</span>
            </h2>
            <p className="lp-live-sub">
              Danielle&apos;s twin is running today, answering followers in
              her voice, recommending the real products she actually wears,
              with real links to where she actually buys them.
            </p>
            <Link
              href="/weworewhat"
              className="lp-btn lp-btn-primary lp-btn-large"
            >
              Try Danielle&apos;s twin
              <ArrowRight />
            </Link>
            <Link href="/creators" className="lp-live-all-link">
              See all creators
              <ArrowRight subtle />
            </Link>
            <ul className="lp-live-stats">
              <li>
                <span className="lp-live-stat-num">2.9M</span>
                <span className="lp-live-stat-label">followers</span>
              </li>
              <li>
                <span className="lp-live-stat-num">∞</span>
                <span className="lp-live-stat-label">
                  products she can recommend
                </span>
              </li>
              <li>
                <span className="lp-live-stat-num">Live</span>
                <span className="lp-live-stat-label">askmai.co/weworewhat</span>
              </li>
            </ul>
          </div>

          <AgentPreviewCard />
        </div>
      </section>

      {/* ---------- VALUE PROP ---------- */}
      <section className="lp-value-prop" data-reveal>
        <p className="lp-eyebrow">For creators</p>
        <h2 className="lp-h2 lp-h2-tight">
          What your twin{" "}
          <span className="lp-accent-ink">does for you.</span>
        </h2>

        <div className="lp-value-grid">
          {VALUE_PILLARS.map((p, i) => (
            <article key={p.title} className="lp-value-pillar" data-reveal>
              <span className="lp-value-num">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="lp-value-pillar-title">{p.title}</h3>
              <p className="lp-value-pillar-body">{p.body}</p>
            </article>
          ))}
        </div>

        <p className="lp-value-closing">
          You keep your existing affiliate. You earn a share of the new
          revenue your twin unlocks.
        </p>
        <a
          href="#waitlist"
          className="lp-btn lp-btn-primary lp-btn-large lp-value-cta"
        >
          Get your twin
          <ArrowRight />
        </a>
      </section>

      {/* ---------- FEATURES ---------- */}
      <section className="lp-features" data-reveal>
        <p className="lp-eyebrow">How it works</p>
        <h2 className="lp-h2 lp-h2-tight">
          Built so your followers actually shop your picks,{" "}
          <span className="lp-accent-ink">not just like them.</span>
        </h2>

        <div className="lp-feature-grid">
          {FEATURES.map((f) => (
            <article key={f.kicker} className="lp-feature" data-reveal>
              <span className="lp-feature-kicker">{f.kicker}</span>
              <h3 className="lp-feature-title">{f.title}</h3>
              <p className="lp-feature-body">{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---------- PITCH ---------- */}
      <section className="lp-pitch" data-reveal>
        <p className="lp-eyebrow">Why join</p>
        <h2 className="lp-pitch-h2">
          Free to join.{" "}
          <span className="lp-accent-ink">
            You earn on what your audience buys.
          </span>
        </h2>
        <div className="lp-pitch-row">
          <div className="lp-pitch-col">
            <h4 className="lp-pitch-col-title">Free to start.</h4>
            <p className="lp-pitch-col-body">
              No setup fee. We build your twin and host it. You stay focused
              on what you already do.
            </p>
          </div>
          <div className="lp-pitch-col">
            <h4 className="lp-pitch-col-title">You earn the commission.</h4>
            <p className="lp-pitch-col-body">
              When your followers buy through your twin, the affiliate
              earnings go to you. Same as a tagged link, fewer steps.
            </p>
          </div>
          <div className="lp-pitch-col">
            <h4 className="lp-pitch-col-title">Premium features coming.</h4>
            <p className="lp-pitch-col-body">
              Owned-brand cards, custom palettes, lookbooks, analytics. Early
              creators get them first.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- WAITLIST ---------- */}
      <section id="waitlist" className="lp-waitlist" data-reveal>
        <p className="lp-eyebrow">Apply</p>
        <h2 className="lp-h2 lp-h2-tight">
          Get your{" "}
          <span className="lp-accent-ink">digital twin.</span>
        </h2>
        <p className="lp-waitlist-sub">
          We&apos;re onboarding a small group of creators next. Drop your
          email and we&apos;ll be in touch.
        </p>
        <form onSubmit={onSubmit} className="lp-form">
          <input
            type="email"
            required
            inputMode="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="lp-input"
            disabled={submitState === "sending" || submitState === "done"}
            aria-label="email"
          />
          <button
            type="submit"
            className="lp-btn lp-btn-primary"
            disabled={
              submitState === "sending" ||
              submitState === "done" ||
              !email.includes("@")
            }
          >
            {submitState === "done"
              ? "You're on the list"
              : submitState === "sending"
              ? "Sending…"
              : "Apply"}
            {submitState !== "done" && <ArrowRight />}
          </button>
        </form>
        {submitState === "done" && (
          <p className="lp-form-note">
            We&apos;ll reach out from hi@askmai.co with next steps.
          </p>
        )}
        {submitState === "error" && (
          <p className="lp-form-note lp-form-note-error">
            Something hiccupped. Try again, or email us at hi@askmai.co.
          </p>
        )}
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer className="lp-footer">
        <span className="lp-wordmark lp-wordmark-sm">
          ask<em>mai</em>
        </span>
        <span className="lp-footer-note">Built in NYC + Miami.</span>
        <span className="lp-footer-meta">
          <a href="mailto:hi@askmai.co" className="lp-footer-link">
            hi@askmai.co
          </a>
        </span>
      </footer>
    </main>
  );
}

function ArrowRight({ subtle }: { subtle?: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={subtle ? "1.4" : "1.6"}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="lp-arrow"
      aria-hidden
    >
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </svg>
  );
}

function NoiseLayer() {
  return (
    <svg
      className="lp-noise"
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <filter id="lp-noise-filter">
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
      <rect width="100%" height="100%" filter="url(#lp-noise-filter)" />
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

const PREVIEW_THUMB_SRC = `/api/img?url=${encodeURIComponent(
  "https://cdn.shopify.com/s/files/1/0025/6049/1566/files/WWD205-01-ZEB_b9dd1c29-821e-410e-9228-7a6844063394.jpg?v=1776706350"
)}`;

function AgentPreviewCard() {
  return (
    <Link
      href="/weworewhat"
      className="lp-preview"
      aria-label="Open Danielle Bernstein's live twin"
    >
      <div className="lp-preview-card">
        <div className="lp-preview-corner">live</div>
        <div className="lp-preview-head">
          <div className="lp-preview-avatar" aria-hidden>
            D
          </div>
          <div className="lp-preview-meta">
            <span className="lp-preview-name">Danielle Bernstein</span>
            <span className="lp-preview-handle">
              @weworewhat · 2.9M followers
            </span>
          </div>
        </div>
        <div className="lp-preview-chat">
          <div className="lp-preview-bubble lp-preview-user">
            I need an outfit for dinner in the city for under $300
          </div>
          <div className="lp-preview-bubble lp-preview-assistant">
            <p>
              easy at $300. my Strapless Foldover Midi in ivory/beige is what
              I&apos;d grab — reads pulled together without trying. leaves you
              room for strappy sandals and a small bag.
            </p>
            <div className="lp-preview-rec">
              <span className="lp-preview-rec-thumb" aria-hidden>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={PREVIEW_THUMB_SRC} alt="" />
              </span>
              <span className="lp-preview-rec-text">
                <strong>WeWoreWhat</strong> Strapless Foldover Midi
                <em>$198</em>
              </span>
            </div>
          </div>
        </div>
        <div className="lp-preview-foot">
          askmai.co/weworewhat
          <ArrowRight subtle />
        </div>
      </div>
    </Link>
  );
}
