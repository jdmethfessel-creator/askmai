/**
 * /forcreators — private pitch page.
 *
 * Unlisted (not linked from the public homepage, robots noindex). Sent
 * to creators directly. Built to feel like a premium product, not a
 * marketing template: the demo is the centerpiece (Mexico City travel
 * question rendering both restaurant picks and a shoppable packing
 * board — the gap-category demo that's the whole pitch).
 *
 * Real catalog images from Madison's feed so what's shown is exactly
 * what the chat produces, not idealized stand-ins.
 */

import Link from "next/link";
import type { Metadata } from "next";
import "../_marketing/landing.css";
import "./forcreators.css";

export const metadata: Metadata = {
  title: "AskMai for Creators",
  description: "Your taste, working while you sleep.",
  robots: { index: false, follow: false, nocache: true },
};

const DEMO_QUESTION =
  "going to mexico city for a long weekend, where should I eat and what do I pack?";

const DEMO_PROSE = (
  <>
    okay <em>mexico city</em> in the long-weekend window is the BEST — dinner
    plans are the whole assignment. i&apos;d eat my way through Roma + Polanco
    and pack things that go from a daytime market to a sit-down dinner without
    you having to think about it.
  </>
);

const DEMO_PLACES = [
  {
    name: "Pujol",
    location: "Polanco",
    action: "Reserve",
  },
  {
    name: "Contramar",
    location: "Roma Norte",
    action: "Reserve",
  },
  {
    name: "Panadería Rosetta",
    location: "Roma Norte",
    action: "Directions",
  },
] as const;

const DEMO_HERO = {
  brand: "Reformation",
  name: "Balia Linen Dress",
  price: "$278",
  image:
    "/api/img?url=" +
    encodeURIComponent("https://static.shopmy.us/uploads/img-product-1751903970581"),
} as const;

const DEMO_FINISHERS = [
  {
    brand: "Quince",
    name: "Italian Leather Tote",
    price: "$154",
    image:
      "/api/img?url=" +
      encodeURIComponent(
        "https://static.shopmy.us/uploads/pretty-prod-1768227109565"
      ),
  },
  {
    brand: "Tony Bianco",
    name: "Florida Sandal",
    price: "$156",
    image:
      "/api/img?url=" +
      encodeURIComponent(
        "https://static.shopmy.us/uploads/pretty-prod-1772155844398"
      ),
  },
] as const;

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
        <p className="fc-demo-label">a real exchange on Madison&apos;s twin</p>
        <h2 className="fc-demo-h2">
          One question. <em>Restaurants, packing, all of it.</em>
        </h2>

        <div className="fc-phone-wrap">
          <div className="fc-phone-aura" aria-hidden />
          <div className="fc-phone">
            <div className="fc-phone-screen">
              <div className="fc-phone-island" aria-hidden />
              <div className="fc-phone-statusbar">
                <span>9:41</span>
                <span className="fc-status-icons" aria-hidden>
                  <SignalIcon />
                  <WifiIcon />
                  <BatteryIcon />
                </span>
              </div>

              <div className="fc-phone-chat">
                <div className="fc-msg-user">{DEMO_QUESTION}</div>

                <div className="fc-msg-twin">
                  <p className="fc-twin-prose">{DEMO_PROSE}</p>

                  <p className="fc-section-label">Where to eat</p>
                  <div className="fc-place-stack">
                    {DEMO_PLACES.map((p) => (
                      <div key={p.name} className="fc-place">
                        <div className="fc-place-meta">
                          <span className="fc-place-name">{p.name}</span>
                          <span className="fc-place-loc">
                            {p.location} · Mexico City
                          </span>
                        </div>
                        <span className="fc-place-action">{p.action}</span>
                      </div>
                    ))}
                  </div>

                  <p className="fc-section-label">What to pack</p>
                  <div className="fc-board-hero">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={DEMO_HERO.image} alt="" />
                    <div className="fc-board-hero-overlay">
                      <div className="fc-board-hero-meta">
                        <span className="fc-board-hero-brand">
                          {DEMO_HERO.brand}
                        </span>
                        <h3 className="fc-board-hero-name">{DEMO_HERO.name}</h3>
                        <span className="fc-board-hero-price">
                          {DEMO_HERO.price}
                        </span>
                      </div>
                      <span className="fc-board-shop" aria-hidden>
                        Shop →
                      </span>
                    </div>
                  </div>
                  <div className="fc-board-finishers">
                    {DEMO_FINISHERS.map((f) => (
                      <article key={f.name} className="fc-board-fin">
                        <div className="fc-board-fin-imgwrap">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={f.image} alt="" />
                        </div>
                        <div className="fc-board-fin-meta">
                          <span className="fc-board-fin-brand">{f.brand}</span>
                          <h4 className="fc-board-fin-name">{f.name}</h4>
                          <span className="fc-board-fin-price">{f.price}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

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

function SignalIcon() {
  return (
    <svg width="16" height="10" viewBox="0 0 16 10" fill="none" aria-hidden>
      <rect x="0" y="6" width="2.5" height="4" rx="0.5" fill="currentColor" />
      <rect x="4" y="4" width="2.5" height="6" rx="0.5" fill="currentColor" />
      <rect x="8" y="2" width="2.5" height="8" rx="0.5" fill="currentColor" />
      <rect x="12" y="0" width="2.5" height="10" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
      <path
        d="M1 3.5A9 9 0 0 1 13 3.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M3 5.5A6 6 0 0 1 11 5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M5 7.5A3 3 0 0 1 9 7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="7" cy="9" r="0.8" fill="currentColor" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg width="22" height="11" viewBox="0 0 22 11" fill="none" aria-hidden>
      <rect
        x="0.5"
        y="0.5"
        width="18"
        height="10"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1"
        fill="none"
        opacity="0.5"
      />
      <rect x="2" y="2" width="14" height="7" rx="1.2" fill="currentColor" />
      <rect x="19.5" y="3.5" width="2" height="4" rx="0.8" fill="currentColor" />
    </svg>
  );
}
