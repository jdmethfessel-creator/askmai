"use client";

/**
 * Homepage - follower-facing.
 *
 * Structure:
 *   1. Hero (try-on lead, placeholder for a real render)
 *   2. Shop preview (real product screenshots in a grid)
 *   3. Mai concierge shown via a question + answer, no explainer copy
 *   4. Fitting Rooms deferred slot (layout only, no content yet)
 *   5. Footer
 *
 * Copy rules honored: no digital twin / your voice / trained on your
 * taste / impersonating language; no em dashes; no parallel-fragment
 * cadence. Cream/tan palette. Real product images, not gradient
 * blobs.
 */

import Link from "next/link";
import NavAuth from "../_components/NavAuth";
import "./landing.css";

// Real catalog imagery reused from the demo assets and the shopmy
// CDN via the existing image proxy. These are the same pieces the
// live catalog renders, so what the homepage previews is what the
// creator page actually produces.
const SHOP_TILES = [
  {
    brand: "Reformation",
    name: "Amara Linen Midi",
    price: "$218",
    image: "/demo/packing/reformation-amara.jpg",
  },
  {
    brand: "Frankies Bikinis",
    name: "Reversible String Set",
    price: "$130",
    image: "/demo/packing/frankies-bikini.jpg",
  },
  {
    brand: "Cult Gaia",
    name: "Hera Bag",
    price: "$598",
    image: "/demo/packing/cult-gaia-hera.jpg",
  },
  {
    brand: "Reformation",
    name: "Balia Linen Dress",
    price: "$258",
    image:
      "/api/img?url=" +
      encodeURIComponent(
        "https://static.shopmy.us/uploads/img-product-1751903970581"
      ),
  },
];

const MAI_ANSWER_TILE = {
  brand: "Rhode Skin",
  name: "Glazing Milk Ceramide Essence",
  price: "$32",
  image:
    "/api/img?url=" +
    encodeURIComponent(
      "https://static.shopmy.us/uploads/9eb95c13-f6b8-4c98-9d43-f90d53719e76_download-2026-05-16T163952.524.png"
    ),
};

export default function Marketing({ signedIn }: { signedIn: boolean }) {
  return (
    <main className="lp-root">
      <header className="lp-nav">
        <span className="lp-wordmark">
          ask<em>mai</em>
        </span>
        <nav className="lp-nav-right">
          <NavAuth
            signedIn={signedIn}
            className="lp-nav-link"
            signedInClassName="lp-nav-signedin"
            modalAccent="#a26a5a"
          />
          <Link href="/forcreators" className="lp-nav-cta">
            For creators
          </Link>
        </nav>
      </header>

      {/* ---------- HERO: try-on ---------- */}
      <section className="lp-hero">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow">Try it on</p>
          <h1 className="lp-h1">
            See it on you <em>before</em> you buy.
          </h1>
          <p className="lp-lead">
            One photo of you, every look your favorite creator wears,
            rendered on your body in seconds.
          </p>
          <div className="lp-cta-row">
            <Link href="/janesmith" className="lp-btn lp-btn-primary">
              Try on Jane&apos;s closet
            </Link>
            <Link href="/madisonwaller" className="lp-btn lp-btn-ghost">
              Or Madison&apos;s
            </Link>
          </div>
        </div>
        <div className="lp-hero-visual">
          {/*
            Placeholder for a real try-on render. Drop a file at
            /public/marketing/tryon-hero.png (portrait, 9:16) and
            it renders here automatically. Falls back to a neutral
            plate so the layout doesn't collapse pre-asset.
          */}
          <div className="lp-hero-render">
            <div className="lp-hero-render-plate" aria-hidden />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/marketing/tryon-hero.png"
              alt=""
              className="lp-hero-render-img"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.opacity = "0";
              }}
            />
          </div>
        </div>
      </section>

      {/* ---------- SHOP ---------- */}
      <section className="lp-section">
        <p className="lp-eyebrow">Shop the closet</p>
        <h2 className="lp-h2">
          Their whole affiliate wardrobe, in a single grid you can
          actually shop.
        </h2>
        <p className="lp-lead lp-lead-sub">
          Real prices, filtered by category, searchable by piece. No
          more scrolling their bio for the right link.
        </p>
        <ul className="lp-shop-grid">
          {SHOP_TILES.map((t) => (
            <li key={t.name} className="lp-shop-tile">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={t.image}
                alt=""
                loading="lazy"
                decoding="async"
                className="lp-shop-tile-img"
              />
              <div className="lp-shop-tile-meta">
                <span className="lp-shop-tile-brand">{t.brand}</span>
                <span className="lp-shop-tile-name">{t.name}</span>
                <span className="lp-shop-tile-price">{t.price}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- MAI: shown via one Q+A, never explained ---------- */}
      <section className="lp-section lp-section-tight">
        <div className="lp-chat">
          <div className="lp-chat-user">
            what would she wear to a wedding in Napa in October?
          </div>
          <div className="lp-chat-mai">
            <p className="lp-chat-mai-body">
              The Balia linen in her closet reads as evening in Napa
              without trying too hard, and she pairs it with the Cult
              Gaia Hera when the light drops.
            </p>
            <div className="lp-chat-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/api/img?url=https%3A%2F%2Fstatic.shopmy.us%2Fuploads%2Fimg-product-1751903970581"
                alt=""
                className="lp-chat-card-img"
              />
              <div className="lp-chat-card-meta">
                <span className="lp-chat-card-brand">Reformation</span>
                <span className="lp-chat-card-name">Balia Linen Dress</span>
                <span className="lp-chat-card-price">$258</span>
              </div>
            </div>
          </div>
          <div className="lp-chat-user">
            skincare, walk me through a simple routine
          </div>
          <div className="lp-chat-mai">
            <p className="lp-chat-mai-body">
              She keeps it to four steps. Vitamin C in the morning, this
              essence to hydrate, moisturize, and a repair serum at
              night.
            </p>
            <div className="lp-chat-card">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={MAI_ANSWER_TILE.image}
                alt=""
                className="lp-chat-card-img"
              />
              <div className="lp-chat-card-meta">
                <span className="lp-chat-card-brand">
                  {MAI_ANSWER_TILE.brand}
                </span>
                <span className="lp-chat-card-name">
                  {MAI_ANSWER_TILE.name}
                </span>
                <span className="lp-chat-card-price">
                  {MAI_ANSWER_TILE.price}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- FITTING ROOMS: layout slot, no content yet ---------- */}
      <section className="lp-section lp-rooms-slot">
        <p className="lp-eyebrow">Coming soon</p>
        <h2 className="lp-h2">Fitting rooms</h2>
        {/* Intentionally empty; layout slot for the shared-fitting-
            rooms surface once Rooms Phase 1 opens up. */}
        <div className="lp-rooms-placeholder" aria-hidden />
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
