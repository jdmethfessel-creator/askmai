/**
 * /forcreators - creator-facing pitch page. Outcomes only, no
 * mechanism labels ("digital twin", "your voice"). Cream/tan
 * palette matching the actual product surface.
 *
 * Structure:
 *   1. Hero (outcome + placeholder for a real render)
 *   2. Try-on conversion (the make-or-break feature)
 *   3. One-page aggregation (with a real logo-row of the networks
 *      we support today)
 *   4. Engagement + DMs shown via a chat exchange, not explained
 *   5. 100% commissions
 *   6. Fitting Rooms deferred slot (layout only, no content yet)
 *   7. How it works (3 steps)
 *   8. Closing CTA
 *
 * The page stays unlisted (robots noindex).
 */

import Link from "next/link";
import type { Metadata } from "next";
import HeroImage from "../_marketing/HeroImage";
import "../_marketing/landing.css";
import "./forcreators.css";

const OG_TITLE = "AskMai for creators";
const OG_DESC =
  "The one link where your followers actually buy. Try-on, one-page aggregation, and every commission still yours.";
const OG_URL = "https://www.askmai.co/forcreators";
const OG_IMAGE = "/og/forcreators.png";

export const metadata: Metadata = {
  title: OG_TITLE,
  description: OG_DESC,
  robots: { index: false, follow: false, nocache: true },
  openGraph: {
    title: OG_TITLE,
    description: OG_DESC,
    url: OG_URL,
    type: "website",
    images: [
      { url: OG_IMAGE, width: 1200, height: 630, alt: OG_TITLE },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: OG_DESC,
    images: [OG_IMAGE],
  },
};

export default function ForCreatorsPage() {
  return (
    <main className="askmai-landing fc-root">
      <header className="lp-nav">
        <span className="lp-wordmark">
          ask<em>mai</em>
        </span>
        <nav className="lp-nav-right">
          <Link href="/" className="lp-nav-link">
            Home
          </Link>
          <Link href="/creator-signup" className="lp-nav-cta">
            Get early access
          </Link>
        </nav>
      </header>

      {/* ---------- HERO ---------- */}
      <section className="lp-hero fc-hero">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow">For creators</p>
          <h1 className="lp-h1">
            The one link where your followers <em>actually buy.</em>
          </h1>
          <p className="lp-lead">
            Try-on turns screenshots into checkouts. Every network you
            already use lands on one page. Every commission stays
            yours.
          </p>
          <div className="lp-cta-row">
            <Link href="/creator-signup" className="lp-btn lp-btn-primary">
              Get early access
            </Link>
          </div>
        </div>
        <div className="lp-hero-visual">
          <div className="lp-hero-render">
            <div className="lp-hero-render-plate" aria-hidden />
            <HeroImage
              src="/marketing/forcreators-hero.png"
              className="lp-hero-render-img"
            />
          </div>
        </div>
      </section>

      {/* ---------- TRY-ON CONVERSION ---------- */}
      <section className="lp-section fc-outcome">
        <p className="lp-eyebrow">Conversion</p>
        <h2 className="lp-h2">
          Your fits, rendered on the person about to shop them.
        </h2>
        <p className="lp-lead lp-lead-sub">
          A follower opens your closet, taps a piece, and sees it on
          themselves. That&apos;s the moment a double-tap turns into
          Add to Cart.
        </p>
        <div className="fc-tryon-frame">
          <HeroImage
            src="/marketing/forcreators-conversion.png"
            className="fc-tryon-frame-img"
          />
          <div className="fc-tryon-frame-plate" aria-hidden />
        </div>
      </section>

      {/* ---------- AGGREGATION ---------- */}
      <section className="lp-section fc-aggregate">
        <p className="lp-eyebrow">One page</p>
        <h2 className="lp-h2">
          ShopMy, Shopbop, Revolve, and FWRD in a single grid.
        </h2>
        <p className="lp-lead lp-lead-sub">
          We pull your entire catalog automatically, keep every
          affiliate URL byte-for-byte, and hand your followers one
          filterable grid instead of a scavenger hunt across your bio.
        </p>
        <ul className="fc-logo-row">
          <li className="fc-logo">ShopMy</li>
          <li className="fc-logo">Shopbop</li>
          <li className="fc-logo">Revolve</li>
          <li className="fc-logo">FWRD</li>
          <li className="fc-logo fc-logo-soon">LTK (soon)</li>
        </ul>
      </section>

      {/* ---------- ENGAGEMENT / DMs (shown, never explained) ---------- */}
      <section className="lp-section lp-section-tight">
        <p className="lp-eyebrow">Engagement</p>
        <h2 className="lp-h2">The DMs you can&apos;t keep up with.</h2>
        <div className="lp-chat">
          <div className="lp-chat-user">
            what&apos;s her tulum hotel?
          </div>
          <div className="lp-chat-mai">
            <p className="lp-chat-mai-body">
              She stayed at Hotel Esencia, quiet beach on the north
              end, and wrote about the food being the reason to book
              it.
            </p>
            <div className="lp-chat-card">
              <div className="fc-place-icon" aria-hidden>
                🏝
              </div>
              <div className="lp-chat-card-meta">
                <span className="lp-chat-card-brand">Hotel</span>
                <span className="lp-chat-card-name">Hotel Esencia</span>
                <span className="lp-chat-card-price">Tulum, Mexico</span>
              </div>
            </div>
          </div>
          <div className="lp-chat-user">
            gold hoops, budget under $200
          </div>
          <div className="lp-chat-mai">
            <p className="lp-chat-mai-body">
              She doesn&apos;t have hoops in her closet right now, but
              she wears these Aureum studs constantly, same warm gold,
              size range close.
            </p>
            <div className="lp-chat-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/api/img?url=https%3A%2F%2Fstatic.shopmy.us%2Fuploads%2Fpretty-prod-1753495753677"
                alt=""
                className="lp-chat-card-img"
              />
              <div className="lp-chat-card-meta">
                <span className="lp-chat-card-brand">Uncommon James</span>
                <span className="lp-chat-card-name">
                  Seeing Double Studs
                </span>
                <span className="lp-chat-card-price">$48</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- 100% COMMISSIONS ---------- */}
      <section className="lp-section fc-money">
        <p className="lp-eyebrow">Your money</p>
        <h2 className="lp-h2">You keep 100%.</h2>
        <p className="lp-lead">
          Every affiliate URL is stored exactly as you wrote it. We
          take zero, no percentage, no spread, no revenue share.
        </p>
      </section>

      {/* ---------- FITTING ROOMS: layout slot, no content yet ---------- */}
      <section className="lp-section lp-rooms-slot">
        <p className="lp-eyebrow">Coming soon</p>
        <h2 className="lp-h2">Fitting rooms</h2>
        {/* Intentional layout slot; wired up when Rooms Phase 1 ships
            to the marketing surface. */}
        <div className="lp-rooms-placeholder" aria-hidden />
      </section>

      {/* ---------- HOW IT WORKS ---------- */}
      <section className="lp-section fc-how">
        <p className="lp-eyebrow">How it works</p>
        <h2 className="lp-h2">Five minutes on your end.</h2>
        <ol className="fc-steps">
          <li className="fc-step">
            <span className="fc-step-num">1</span>
            <div className="fc-step-body">
              <h3 className="fc-step-title">Paste your affiliate links.</h3>
              <p className="fc-step-note">
                ShopMy, Shopbop, Revolve, FWRD. We pull the catalog and
                keep the URLs byte-for-byte.
              </p>
            </div>
          </li>
          <li className="fc-step">
            <span className="fc-step-num">2</span>
            <div className="fc-step-body">
              <h3 className="fc-step-title">Connect your blog.</h3>
              <p className="fc-step-note">
                Everything you&apos;ve already written stays
                answerable, from Tulum hotels to skincare routines.
              </p>
            </div>
          </li>
          <li className="fc-step">
            <span className="fc-step-num">3</span>
            <div className="fc-step-body">
              <h3 className="fc-step-title">
                Share askmai.co/yourhandle.
              </h3>
              <p className="fc-step-note">
                One link in bio. Followers do the rest.
              </p>
            </div>
          </li>
        </ol>
      </section>

      {/* ---------- CLOSE ---------- */}
      <section className="lp-section fc-close">
        <h2 className="lp-h2">Ready when you are.</h2>
        <Link href="/creator-signup" className="lp-btn lp-btn-primary">
          Get early access
        </Link>
        <p className="fc-close-sub">
          Small group of creators onboarding now.
        </p>
      </section>

      <footer className="lp-footer">
        <span className="lp-wordmark lp-wordmark-sm">
          ask<em>mai</em>
        </span>
        <a href="mailto:hi@askmai.co" className="lp-footer-link">
          hi@askmai.co
        </a>
      </footer>
    </main>
  );
}
