"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import "./landing.css";

// ---------------------------------------------------------------
// Mockup product data.
// Real products from the live catalog so the homepage renders the
// SAME images and the SAME card shape the actual chat produces — no
// abstract icons, no placeholder rectangles. The page is framed as
// "this is what AskMai produces," not as a specific creator's
// endorsement: no creator name, handle, or avatar is shown alongside
// these cards.
// ---------------------------------------------------------------

type MockupRec = {
  brand: string;
  name: string;
  price: string;
  image: string;
};

// Three mockups, three distinct categories, all in the
// question → answer → board format so the mechanic is obvious
// at a glance. No restaurants / hotels / travel-booking — those
// aren't categories the product serves yet.

// 1) Special-occasion single look.
//
// Price story matters here — the hero mockup is the first thing a
// cold visitor sees, so the board can't read as "luxury-only or
// don't bother." Anchor with one investment piece (the dress does
// the visual work) and pair it with accessible finishers under
// $50 and $150 so the range looks realistic. Real catalog items
// only.
const WEDDING_QUESTION = "what do I wear to a fall wedding";
const WEDDING_CAPTION =
  "fall wedding = one piece that does the work, the rest can be quiet. let the dress carry it, then mix in pieces you'll actually re-wear.";
const WEDDING_BOARD: { hero: MockupRec; finishers: MockupRec[] } = {
  hero: {
    brand: "Solace London",
    name: "The Imani Maxi Dress",
    price: "$945",
    image:
      "/api/img?url=" +
      encodeURIComponent(
        "https://static.shopmy.us/uploads/pretty-prod-1761845774367"
      ),
  },
  finishers: [
    {
      brand: "Tony Bianco",
      name: "Caprice Heel",
      price: "$150",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1771324332426"
        ),
    },
    {
      brand: "Abbode",
      name: "Signature Waffle Pouch",
      price: "$78",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/30316e12-d049-4a87-bffe-dcee5a612273_image-1760052402236"
        ),
    },
    {
      brand: "Uncommon James",
      name: "Seeing Double Earrings",
      price: "$48",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1753495753677"
        ),
    },
  ],
};

// 2) Multi-outfit travel/packing — the existing strong example.
const PACK_QUESTION = "what should I pack for a NYC weekend";
const PACK_CAPTION =
  "okay a NYC weekend = walk-all-day, dress for dinner. here's what i'd pack:";
const PACK_BOARD: { hero: MockupRec; finishers: MockupRec[] } = {
  hero: {
    brand: "Citizens of Humanity",
    name: "Brynn Drawstring Jeans",
    price: "$298",
    image:
      "/api/img?url=" +
      encodeURIComponent(
        "https://static.shopmy.us/uploads/pretty-prod-1773958253330"
      ),
  },
  finishers: [
    {
      brand: "Enza Costa",
      name: "Twill Everywhere Pants",
      price: "$295",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1778590419800"
        ),
    },
    {
      brand: "Ring Concierge",
      name: "Pavé Diamond Cloud Ring",
      price: "$898",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/img-product-1732498195189"
        ),
    },
  ],
};

// 3) Beauty/skincare routine — same mechanic, different category.
const SKIN_QUESTION = "build me a simple skincare routine";
const SKIN_CAPTION =
  "simple routine, real results. C E Ferulic in the morning, hydrate, moisturize, repair at night. that's the whole game.";
const SKIN_BOARD: { hero: MockupRec; finishers: MockupRec[] } = {
  hero: {
    brand: "SkinCeuticals",
    name: "C E Ferulic Vitamin C Serum",
    price: "$185",
    image:
      "/api/img?url=" +
      encodeURIComponent(
        "https://static.shopmy.us/uploads/pretty-prod-1775027500571"
      ),
  },
  finishers: [
    {
      brand: "Rhode Skin",
      name: "Glazing Milk Ceramide Essence",
      price: "$32",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/9eb95c13-f6b8-4c98-9d43-f90d53719e76_download-2026-05-16T163952.524.png"
        ),
    },
    {
      brand: "Charlotte Tilbury",
      name: "Magic Cream Moisturizer",
      price: "$32",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1775973078244"
        ),
    },
    {
      brand: "Dieux",
      name: "Deliverance 3-in-1 Repair Serum",
      price: "$62",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1779311904381"
        ),
    },
  ],
};

// ---------------------------------------------------------------

export default function Marketing() {
  // Scroll-triggered reveals — sections fade in on intersect. Kept
  // from the prior page so the atmosphere is consistent.
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
      { rootMargin: "-10% 0px -5% 0px", threshold: 0.05 }
    );
    observerRef.current = io;
    document
      .querySelectorAll<HTMLElement>("[data-reveal]")
      .forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <main className="lp-root">
      <NoiseLayer />
      <BackgroundGlow />

      <header className="lp-nav">
        <span className="lp-wordmark">
          ask<em>mai</em>
        </span>
        <nav className="lp-nav-right">
          <Link href="/creator-signup" className="lp-nav-cta">
            Creator Sign Up
          </Link>
        </nav>
      </header>

      {/* ---------- HERO ---------- */}
      <section className="lp-hero-v2">
        <div className="lp-hero-grid">
          <div className="lp-hero-copy">
            <p
              className="lp-eyebrow lp-fade-in"
              style={{ animationDelay: "80ms" }}
            >
              For creators
            </p>
            <h1
              className="lp-hero-h1 lp-fade-in"
              style={{ animationDelay: "200ms" }}
            >
              Your digital twin.
            </h1>
            <p
              className="lp-sub lp-fade-in"
              style={{ animationDelay: "400ms" }}
            >
              Engages your followers in your{" "}
              <span className="lp-accent-ink">voice,</span> and monetizes
              the{" "}
              <span className="lp-accent-ink">links</span> you already
              have.
            </p>
            <div
              className="lp-cta-row lp-fade-in"
              style={{ animationDelay: "560ms" }}
            >
              <Link
                href="/creator-signup"
                className="lp-btn lp-btn-primary lp-btn-large"
              >
                Creator Sign Up
                <ArrowRight />
              </Link>
            </div>
          </div>

          <div className="lp-hero-board lp-fade-in" style={{ animationDelay: "520ms" }}>
            <ChatMockup
              userMessage={WEDDING_QUESTION}
              twinIntro={WEDDING_CAPTION}
              hero={WEDDING_BOARD.hero}
              finishers={WEDDING_BOARD.finishers}
            />
          </div>
        </div>
      </section>

      {/* ---------- EARN MORE ---------- */}
      <section className="lp-pillar lp-pillar-image-left" data-reveal>
        <div className="lp-pillar-visual">
          <ChatMockup
            userMessage={SKIN_QUESTION}
            twinIntro={SKIN_CAPTION}
            hero={SKIN_BOARD.hero}
            finishers={SKIN_BOARD.finishers}
          />
        </div>
        <div className="lp-pillar-copy">
          <p className="lp-eyebrow">Same links, more revenue</p>
          <h2 className="lp-h2 lp-h2-tight">
            Earn more on the links{" "}
            <span className="lp-accent-ink">you already have.</span>
          </h2>
          <p className="lp-pillar-body">
            Plug in your existing ShopMy or LTK feed. Your twin recommends
            the real products you already monetize — every card carries
            your attribution, every click pays you. Nothing to switch,
            nothing to relearn.
          </p>
          <ul className="lp-bullets">
            <li>Real product photos, real prices, real Shop buttons.</li>
            <li>Your affiliate link, never anyone else&apos;s.</li>
            <li>Works alongside your existing posts and link-in-bio.</li>
          </ul>
        </div>
      </section>

      {/* ---------- 24/7 ---------- */}
      <section className="lp-pillar lp-pillar-image-right" data-reveal>
        <div className="lp-pillar-copy">
          <p className="lp-eyebrow">Always on</p>
          <h2 className="lp-h2 lp-h2-tight">
            Available to every follower,{" "}
            <span className="lp-accent-ink">24/7, in your voice.</span>
          </h2>
          <p className="lp-pillar-body">
            Your audience asks the questions they&apos;d normally DM —
            &ldquo;what should I pack for a NYC weekend,&rdquo; &ldquo;cute
            going-out top&rdquo; — and your twin answers in your voice,
            with named products they can shop on the spot. Every
            follower, at the same time, every hour.
          </p>
          <ul className="lp-bullets">
            <li>Conversational, not a feed.</li>
            <li>Trained on your taste, not a generic recommender.</li>
            <li>Hosted at askmai.co/yourhandle for your bio link.</li>
          </ul>
        </div>
        <div className="lp-pillar-visual">
          <ChatMockup
            userMessage={PACK_QUESTION}
            twinIntro={PACK_CAPTION}
            hero={PACK_BOARD.hero}
            finishers={PACK_BOARD.finishers}
          />
        </div>
      </section>

      {/* ---------- CTA ---------- */}
      <section className="lp-cta" data-reveal>
        <p className="lp-eyebrow">Apply</p>
        <h2 className="lp-cta-h2">
          Change nothing.{" "}
          <span className="lp-accent-ink">Earn more.</span>
        </h2>
        <p className="lp-cta-sub">
          We&apos;re onboarding a small group of creators next. Tell us
          where to find you and we&apos;ll be in touch.
        </p>
        <Link
          href="/creator-signup"
          className="lp-btn lp-btn-primary lp-btn-large"
        >
          Creator Sign Up
          <ArrowRight />
        </Link>
      </section>

      {/* ---------- FOOTER ---------- */}
      <footer className="lp-footer">
        <span className="lp-wordmark lp-wordmark-sm">
          ask<em>mai</em>
        </span>
        <span className="lp-footer-meta">
          <a href="mailto:hi@askmai.co" className="lp-footer-link">
            hi@askmai.co
          </a>
        </span>
      </footer>
    </main>
  );
}

// ---------------------------------------------------------------
// Mockup components.
// Render the SAME visual structure as the live EditorialBoard /
// HeroProduct / FinisherCard in src/app/[slug]/Chat.tsx so the
// homepage previews look identical to the real product, not an
// idealized stand-in. Generic "your twin" framing — no creator
// avatar, name, or handle is shown.
// ---------------------------------------------------------------

function ResultBoardMockup({
  caption,
  hero,
  finishers,
  variant,
  showShopPills = false,
}: {
  caption: string;
  hero: MockupRec;
  finishers: MockupRec[];
  variant: "hero" | "standard";
  showShopPills?: boolean;
}) {
  return (
    <div className={`lp-board lp-board-${variant}`}>
      <p className="lp-board-caption">{caption}</p>
      <div className="lp-board-cover">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={hero.image} alt="" className="lp-board-cover-img" />
        <div className="lp-board-cover-overlay">
          <div className="lp-board-cover-meta">
            <span className="lp-board-cover-brand">{hero.brand}</span>
            <h3 className="lp-board-cover-name">{hero.name}</h3>
            <span className="lp-board-cover-price">{hero.price}</span>
          </div>
          <span className="lp-board-shop-pill" aria-hidden>
            Shop →
          </span>
        </div>
      </div>
      <div className="lp-board-finishers">
        {finishers.map((f) => (
          <article key={f.name} className="lp-board-fin">
            <div className="lp-board-fin-imgwrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.image} alt="" className="lp-board-fin-img" />
            </div>
            <div className="lp-board-fin-meta">
              <span className="lp-board-fin-brand">{f.brand}</span>
              <h4 className="lp-board-fin-name">{f.name}</h4>
              <div className="lp-board-fin-bottom">
                <span className="lp-board-fin-price">{f.price}</span>
                {showShopPills && (
                  <span className="lp-board-fin-shop" aria-hidden>
                    Shop →
                  </span>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function ChatMockup({
  userMessage,
  twinIntro,
  hero,
  finishers,
}: {
  userMessage: string;
  twinIntro: string;
  hero: MockupRec;
  finishers: MockupRec[];
}) {
  return (
    <div className="lp-chat">
      <div className="lp-chat-bubble lp-chat-user">{userMessage}</div>
      <div className="lp-chat-bubble lp-chat-twin">
        <ResultBoardMockup
          caption={twinIntro}
          hero={hero}
          finishers={finishers}
          variant="standard"
          showShopPills={false}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
// Atmospheric layers (unchanged from prior landing) + arrow icon.
// ---------------------------------------------------------------

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

function ArrowRight({ subtle = false }: { subtle?: boolean }) {
  return (
    <svg
      className={`lp-arrow${subtle ? " lp-arrow-subtle" : ""}`}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </svg>
  );
}
