/**
 * /forcreators - private pitch page.
 *
 * Unlisted (not linked from the public homepage, robots noindex).
 * Handed directly to creators. Post-Mai-repositioning: pitch leads
 * with the try-on hero visual (the make-or-break feature nobody
 * else has), then the aggregation value (all your affiliate links
 * in one page), then Mai (assistant, not a bot pretending to be
 * you), then commissions.
 *
 * DemoCarousel replaced with static styled preview panels so the
 * page shows the actual product surfaces rather than scripted
 * exchanges.
 */

import Link from "next/link";
import type { Metadata } from "next";
import "../_marketing/landing.css";
import "./forcreators.css";

const OG_TITLE = "AskMai for Creators";
const OG_DESC =
  "Your affiliate wardrobe, on your followers. Every link, one page. Every commission, yours.";
const OG_URL = "https://www.askmai.co/forcreators";
const OG_IMAGE = "/og/forcreators.png";

export const metadata: Metadata = {
  title: "AskMai for Creators",
  description: OG_DESC,
  robots: { index: false, follow: false, nocache: true },
  openGraph: {
    title: OG_TITLE,
    description: OG_DESC,
    url: OG_URL,
    type: "website",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: OG_TITLE,
      },
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
      <NoiseLayer />
      <BackgroundGlow />

      {/* ----------- HERO ----------- */}
      <section className="fc-hero">
        <p className="fc-eyebrow">For creators</p>
        <h1 className="fc-hero-h1">
          Your affiliate wardrobe,{" "}
          <em>on your followers.</em>
        </h1>
        <p className="fc-hero-body">
          Every recommendation you&apos;ve ever posted, live and
          shoppable on one page. Your followers try on your looks on
          themselves before they buy. Mai answers everything you
          haven&apos;t linked. You keep every commission.
        </p>
        <div className="fc-hero-cta-row">
          <Link href="/creator-signup" className="fc-hero-cta">
            Get early access <ArrowRight />
          </Link>
        </div>
      </section>

      {/* ----------- (b) TRY-ON HERO ----------- */}
      <section className="fc-tryon" id="tryon">
        <p className="fc-section-eyebrow">The move</p>
        <h2 className="fc-section-h2">
          They see themselves in it. <em>Then they buy it.</em>
        </h2>
        <p className="fc-section-body">
          A follower screenshots your fit. Uploads a photo of
          themselves. Sees themselves wearing every piece. Taps Shop.
          You get paid.
        </p>

        <div className="fc-tryon-visual">
          <TryOnMockup />
        </div>

        <p className="fc-section-caption">
          Nobody else does this. It&apos;s the reason someone taps
          buy instead of screenshotting and forgetting.
        </p>
      </section>

      {/* ----------- (a) AGGREGATE ----------- */}
      <section className="fc-aggregate">
        <p className="fc-section-eyebrow">One place</p>
        <h2 className="fc-section-h2">
          Every link, <em>one page.</em>
        </h2>
        <p className="fc-section-body">
          ShopMy, Shopbop, Revolve, FWRD — we pull them all into
          your askmai.co/handle. Your followers never scroll your
          bio for the right link again. LTK support coming; every
          other network works today.
        </p>
        <div className="fc-networks-row">
          <span className="fc-network-chip">ShopMy</span>
          <span className="fc-network-chip">Shopbop</span>
          <span className="fc-network-chip">Revolve</span>
          <span className="fc-network-chip">FWRD</span>
          <span className="fc-network-chip fc-network-chip-soon">
            LTK · soon
          </span>
        </div>
        <div className="fc-shop-visual">
          <ShopMockup />
        </div>
      </section>

      {/* ----------- (c) MAI ----------- */}
      <section className="fc-mai">
        <p className="fc-section-eyebrow">Meet Mai</p>
        <h2 className="fc-section-h2">
          Mai answers everything you haven&apos;t linked.{" "}
          <em>In your voice — without pretending to be you.</em>
        </h2>
        <p className="fc-section-body">
          Mai is your styling assistant. She reads your affiliate
          catalog and your blog. When someone asks &quot;what&apos;s
          your Tulum hotel?&quot; Mai answers — because you wrote it
          once, and now it&apos;s discoverable forever. She&apos;s a
          consistent assistant, not a bot impersonating you.
        </p>
        <div className="fc-chat-visual">
          <ChatMockup />
        </div>
        <p className="fc-section-caption">
          Fashion, travel, dining. Every rec you&apos;ve ever posted,
          answerable on demand.
        </p>
      </section>

      {/* ----------- (d) COMMISSIONS ----------- */}
      <section className="fc-money">
        <p className="fc-section-eyebrow">Your money</p>
        <h2 className="fc-section-h2">
          You keep <em>100%.</em>
        </h2>
        <p className="fc-section-body">
          Every affiliate URL is stored byte-for-byte, exactly as
          you wrote it. Every commission is yours. We take zero. Not
          a percentage, not a spread, nothing.
        </p>
      </section>

      {/* ----------- HOW IT WORKS ----------- */}
      <section className="fc-how">
        <p className="fc-section-eyebrow">How it works</p>
        <h2 className="fc-section-h2">Effortless on your end.</h2>
        <ol className="fc-steps">
          <li className="fc-step">
            <p className="fc-step-body">
              <strong>Paste your affiliate links.</strong> ShopMy,
              Shopbop, Revolve, FWRD. Five minutes.
            </p>
          </li>
          <li className="fc-step">
            <p className="fc-step-body">
              <strong>Paste your blog links.</strong> Mai reads them
              for travel, dining, and lifestyle answers.
            </p>
          </li>
          <li className="fc-step">
            <p className="fc-step-body">
              <strong>Share your askmai.co/handle.</strong>{" "}
              Followers do the rest.
            </p>
          </li>
        </ol>
      </section>

      {/* ----------- CLOSE ----------- */}
      <section className="fc-close">
        <h2 className="fc-close-h2">
          Ready when you are.
        </h2>
        <Link href="/creator-signup" className="fc-close-cta">
          Get early access <ArrowRight />
        </Link>
        <p className="fc-close-sub">
          Small group of creators onboarding now.
        </p>
      </section>

      <footer className="fc-footer">AskMai · For Creators</footer>
    </main>
  );
}

/* ---------- Product mockups (static styled panels) ---------- */

/**
 * TryOnMockup - shows a "before / after" phone frame. Before: the
 * creator's outfit card. After: the same outfit rendered on the
 * follower. Cream product palette so the mockup matches the actual
 * try-on surface at askmai.co/[slug]?mode=shop.
 */
function TryOnMockup() {
  return (
    <div className="fc-mockup-row">
      <div className="fc-phone fc-phone-before">
        <div className="fc-phone-notch" aria-hidden />
        <div className="fc-phone-screen fc-phone-screen-cream">
          <div className="fc-mock-header">
            <p className="fc-mock-eyebrow">SEARCH MY CLOSET AND FAVORITE FINDS</p>
            <p className="fc-mock-title">Cass</p>
            <div className="fc-mock-toggle">
              <span className="fc-mock-toggle-btn fc-mock-toggle-btn-active">Shop</span>
              <span className="fc-mock-toggle-btn">Ask</span>
              <span className="fc-mock-toggle-btn">Try On</span>
            </div>
          </div>
          <div className="fc-mock-card fc-mock-card-product">
            <div className="fc-mock-card-image">
              <span className="fc-mock-card-image-tag" aria-hidden>👗</span>
            </div>
            <div className="fc-mock-card-meta">
              <p className="fc-mock-card-brand">THE FRANKIE SHOP</p>
              <p className="fc-mock-card-title">Alrose Midi Skirt</p>
              <p className="fc-mock-card-price">$285</p>
            </div>
            <div className="fc-mock-card-actions">
              <span className="fc-mock-btn fc-mock-btn-primary">Try This On</span>
              <span className="fc-mock-btn fc-mock-btn-secondary">Shop</span>
            </div>
          </div>
        </div>
      </div>

      <div className="fc-tryon-arrow" aria-hidden>
        →
      </div>

      <div className="fc-phone fc-phone-after">
        <div className="fc-phone-notch" aria-hidden />
        <div className="fc-phone-screen fc-phone-screen-cream">
          <div className="fc-mock-tryon-result">
            <div className="fc-mock-tryon-figure" aria-hidden>
              <span className="fc-mock-tryon-tag">Rendered on you</span>
            </div>
            <div className="fc-mock-tryon-actions">
              <p className="fc-mock-tryon-caption">
                Here&apos;s the Alrose on you.
              </p>
              <span className="fc-mock-btn fc-mock-btn-primary fc-mock-btn-full">
                Shop the piece →
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * ShopMockup - a small strip of product cards showing that all
 * networks land in one grid. Cream palette to match Shop tab.
 */
function ShopMockup() {
  const items: Array<{ brand: string; title: string; price: string; emoji: string }> = [
    { brand: "TOTEME", title: "Curved Seam Tee", price: "$220", emoji: "👚" },
    { brand: "KHAITE", title: "Cambie Pant", price: "$1,380", emoji: "👖" },
    { brand: "BOTTEGA VENETA", title: "Alfie Flat Sandal", price: "$1,250", emoji: "👡" },
    { brand: "AUREUM", title: "Nova Ring", price: "$185", emoji: "💍" },
  ];
  return (
    <div className="fc-shop-grid">
      {items.map((it) => (
        <div className="fc-mock-card fc-mock-card-shop" key={it.title}>
          <div className="fc-mock-card-image">
            <span className="fc-mock-card-image-tag" aria-hidden>
              {it.emoji}
            </span>
            <span className="fc-mock-card-plus" aria-hidden>+</span>
          </div>
          <div className="fc-mock-card-meta">
            <p className="fc-mock-card-brand">{it.brand}</p>
            <p className="fc-mock-card-title">{it.title}</p>
            <p className="fc-mock-card-price">{it.price}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * ChatMockup - Mai answering a travel + a fashion question in the
 * cream chat palette. Shows the assistant framing (Mai as a
 * distinct name) and product/place cards under her prose.
 */
function ChatMockup() {
  return (
    <div className="fc-phone fc-phone-chat">
      <div className="fc-phone-notch" aria-hidden />
      <div className="fc-phone-screen fc-phone-screen-cream">
        <div className="fc-mock-header">
          <p className="fc-mock-eyebrow">ASK ME ANYTHING</p>
          <p className="fc-mock-title">Cass</p>
          <div className="fc-mock-toggle">
            <span className="fc-mock-toggle-btn">Shop</span>
            <span className="fc-mock-toggle-btn fc-mock-toggle-btn-active">Ask</span>
            <span className="fc-mock-toggle-btn">Try On</span>
          </div>
        </div>
        <div className="fc-mock-chat">
          <div className="fc-mock-bubble fc-mock-bubble-user">
            what&apos;s her tulum hotel?
          </div>
          <div className="fc-mock-bubble fc-mock-bubble-mai">
            her tulum piece is on her blog — she stayed at Hotel
            Esencia. quiet beach, food&apos;s the reason to go. here&apos;s
            what she wrote:
          </div>
          <div className="fc-mock-card fc-mock-card-place">
            <div className="fc-mock-card-place-icon" aria-hidden>🏝</div>
            <div className="fc-mock-card-meta">
              <p className="fc-mock-card-brand">HOTEL</p>
              <p className="fc-mock-card-title">Hotel Esencia</p>
              <p className="fc-mock-card-place-note">Tulum, Mexico</p>
            </div>
          </div>
          <div className="fc-mock-bubble fc-mock-bubble-user">
            gold hoop earrings?
          </div>
          <div className="fc-mock-bubble fc-mock-bubble-mai">
            cass doesn&apos;t actually have gold hoops in her closet
            right now — closest thing she has is a pair of aureum
            studs. not hoops but the same warm gold, same size range.
            want me to look off-catalog for real hoops?
          </div>
        </div>
      </div>
    </div>
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
