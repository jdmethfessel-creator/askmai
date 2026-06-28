"use client";

/**
 * Pinterest-style masonry grid surface for the try-on experience.
 *
 * Layout zones (top-to-bottom):
 *   - Header strip: creator name + tagline.
 *   - Sticky category bar: "All" + one pill per non-empty subcategory.
 *   - Masonry grid: column-based CSS layout so cards drop in by
 *     shortest column (Pinterest-style). Each card has Try-On + Shop.
 *   - Bottom pinned search bar ("ask for something specific..."): a
 *     simple search input that filters the grid. The chat is intent-
 *     ionally demoted to optional; visual browsing is the entry
 *     point.
 *
 * Pagination strategy:
 *   - Server paginates by created_at cursor (40 per page).
 *   - Client loads the next page when an IntersectionObserver sentinel
 *     enters the viewport. Filter/search resets the list and re-fetches
 *     from the start; no stale rows from a prior filter survive.
 *   - Image loading="lazy" + decoding="async" so the browser only
 *     decodes cards near the viewport; this is how we stay smooth on
 *     mobile with ~1k FWRD items.
 *
 * Try-On click contract:
 *   POST /api/render with body {
 *     kind: "single",
 *     creatorSlug,
 *     items: [{ image_url, name, brand }]
 *   }
 *   That endpoint enforces every gate (sign-in, age, photo, quota) so
 *   we keep the client thin: surface the response code's message and
 *   open the result modal on success.
 *
 * Shop click contract:
 *   window.open(product.affiliate_url, "_blank", "noopener,noreferrer")
 *   The stored URL is byte-for-byte the affiliate URL the parser
 *   captured. Never decode, re-encode, or normalize it here.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SignInModal from "../_components/SignInModal";
import RenderLoadingState from "./RenderLoadingState";
import BeforeAfterReveal from "./BeforeAfterReveal";
import {
  composeRevealVideo,
  composeSideBySide,
  recorderMimeAvailable,
} from "./beforeAfter";

type Product = {
  id: string;
  source_network: string;
  product_title: string;
  brand: string | null;
  price: number | null;
  price_display: string | null;
  image_url: string;
  affiliate_url: string;
  product_category: string | null;
  product_subcategory: string | null;
};

type Category = { key: string; label: string; count: number };

type Interpreted = {
  subcategory: string | null;
  maxPrice: number | null;
  descriptors: string[];
  relaxed: "none" | "descriptors" | "price" | "subcategory" | "all";
  caption: string | null;
};

type RenderResult =
  | { state: "idle" }
  | { state: "loading"; product: Product }
  | {
      state: "result";
      product: Product;
      signedUrl: string;
      beforeSignedUrl: string | null;
    }
  | { state: "blocked"; product: Product; reason: BlockReason };

// Per-card eligibility for the body-render Try-On button. Items in
// these subcategory buckets are clothing/accessories FASHN can place
// on the body. Jewelry, earrings, beauty, home, etc. show Shop only.
// Shoes excluded intentionally for now (FASHN's tryon-v1.6 categories
// are tops/bottoms/one-pieces; shoes need different geometry).
//
// Edit this constant to expand or contract the renderable set.
const TRYON_ELIGIBLE_CATEGORIES = new Set<string>([
  "tops",
  "bottoms",
  "dresses",
  "bags",
]);

// Outfit slot the product fills. One slot per item; the outfit
// builder enforces uniqueness per slot and the dress/separates
// conflict (dress excludes top+bottom). Keep the values stable; they
// drive the conflict-resolution logic below.
type OutfitSlot = "top" | "bottom" | "dress" | "bag";
const SUBCATEGORY_TO_SLOT: Record<string, OutfitSlot> = {
  tops: "top",
  bottoms: "bottom",
  dresses: "dress",
  bags: "bag",
};

const MAX_OUTFIT_ITEMS = 3;

function isEligibleForTryOn(product: Product): boolean {
  const sub = (product.product_subcategory ?? "").toLowerCase();
  return TRYON_ELIGIBLE_CATEGORIES.has(sub);
}

function slotFor(product: Product): OutfitSlot | null {
  const sub = (product.product_subcategory ?? "").toLowerCase();
  return SUBCATEGORY_TO_SLOT[sub] ?? null;
}

// Outfit-specific render result (separate from the single-item
// RenderResult so the existing single flow stays untouched). The
// modal shows the full set of products so each one keeps its own
// Shop button with byte-for-byte affiliate URL.
type OutfitRender =
  | { state: "idle" }
  | { state: "loading"; products: Product[] }
  | {
      state: "result";
      products: Product[];
      signedUrl: string;
      beforeSignedUrl: string | null;
    }
  | { state: "blocked"; products: Product[]; reason: BlockReason };

type BlockReason =
  | "age_not_verified"
  | "no_photo"
  | "no_quota"
  | "moderation_blocked"
  | "render_failed";

// not_signed_in is intentionally NOT in BlockReason. When the render
// endpoint returns 401 we open the existing SignInModal in-place; the
// modal captures window.location.pathname as returnTo so the magic
// link lands the user back on /cassdimicconew automatically. After
// the SignInModal reload-button completes, the same Try-On click will
// re-run from a signed-in session.
const REASON_COPY: Record<BlockReason, { title: string; body: string; cta?: { label: string; href: string } }> = {
  age_not_verified: {
    title: "Quick age check",
    body: "Confirm your age once in your profile, then we can render.",
    cta: { label: "Open profile", href: "/profile" },
  },
  no_photo: {
    title: "Upload your try-on photo",
    body: "Add a full-body photo in your profile, then come back and tap Try This On.",
    cta: { label: "Open profile", href: "/profile" },
  },
  no_quota: {
    title: "Out of renders",
    body: "You've used your monthly renders. Grab a pack to keep going.",
    cta: { label: "Get more", href: "/profile" },
  },
  moderation_blocked: {
    title: "Safety filter caught this one",
    body: "OpenAI's safety filter flagged this combination after generating it. It's probabilistic, so it can pass on a retry, or you can try a different garment or a different photo.",
  },
  render_failed: {
    title: "Something went sideways",
    body: "The render didn't come through. Try again in a moment.",
  },
};

const PAGE_SIZE = 40;

export default function TryOnGrid({
  creatorSlug,
  creatorName,
  creatorBio,
  signedIn,
}: {
  creatorSlug: string;
  creatorName: string;
  creatorBio: string | null;
  signedIn: boolean;
}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [render, setRender] = useState<RenderResult>({ state: "idle" });
  const [showSignIn, setShowSignIn] = useState(false);
  const [interpreted, setInterpreted] = useState<Interpreted | null>(null);
  // Outfit builder state. Stored as a slot-keyed object so insertion
  // order is preserved on iteration (object literal order ===
  // insertion order in modern engines) and conflict resolution is
  // O(1) per operation. Capped at MAX_OUTFIT_ITEMS via toggleOutfit.
  const [outfit, setOutfit] = useState<Partial<Record<OutfitSlot, Product>>>(
    {}
  );
  const [outfitRender, setOutfitRender] = useState<OutfitRender>({
    state: "idle",
  });

  // Each fetch round bumps the token; in-flight responses for a stale
  // token are discarded. Prevents a slow first-page response from
  // overwriting the user's new filter selection.
  const fetchTokenRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // ------------------------- category load ---------------------------
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tryon-grid/${creatorSlug}/categories`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (Array.isArray(j.categories)) setCategories(j.categories);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [creatorSlug]);

  // ------------------------- page fetch ------------------------------
  const fetchPage = useCallback(
    async (opts: { reset: boolean }) => {
      const token = ++fetchTokenRef.current;
      setLoadingPage(true);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        if (!opts.reset && cursor) params.set("cursor", cursor);
        if (activeCategory !== "all") params.set("subcategory", activeCategory);
        if (appliedQuery) params.set("q", appliedQuery);
        const res = await fetch(
          `/api/tryon-grid/${creatorSlug}/products?${params.toString()}`
        );
        if (token !== fetchTokenRef.current) return; // stale
        if (!res.ok) {
          setHasMore(false);
          return;
        }
        const j = await res.json();
        const incoming: Product[] = Array.isArray(j.products) ? j.products : [];
        setProducts((prev) => (opts.reset ? incoming : [...prev, ...incoming]));
        setCursor(j.nextCursor ?? null);
        setHasMore(Boolean(j.nextCursor));
        // Only update interpreted on a reset fetch; subsequent
        // pagination fetches reuse the same interpretation.
        if (opts.reset) {
          setInterpreted(j.interpreted ?? null);
        }
      } finally {
        if (token === fetchTokenRef.current) setLoadingPage(false);
      }
    },
    [activeCategory, appliedQuery, creatorSlug, cursor]
  );

  // Reset + first page whenever the filter or applied search changes.
  useEffect(() => {
    setProducts([]);
    setCursor(null);
    setHasMore(true);
    fetchPage({ reset: true });
    // intentionally exclude fetchPage from deps so it doesn't loop on
    // the page-cursor change cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory, appliedQuery, creatorSlug]);

  // Infinite scroll sentinel: load the next page when the trailing
  // div enters the viewport. The 600px rootMargin pre-fetches before
  // the user actually hits the bottom so the grid feels seamless.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasMore && !loadingPage) {
          fetchPage({ reset: false });
        }
      },
      { rootMargin: "600px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [fetchPage, hasMore, loadingPage]);

  // ------------------------- try-on flow -----------------------------
  const onTryOn = useCallback(
    async (product: Product) => {
      setRender({ state: "loading", product });
      try {
        const res = await fetch("/api/render", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "single",
            creatorSlug,
            items: [
              {
                image_url: product.image_url,
                name: product.product_title,
                brand: product.brand ?? undefined,
                category: product.product_subcategory ?? undefined,
              },
            ],
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 200 && json.signed_url) {
          setRender({
            state: "result",
            product,
            signedUrl: json.signed_url,
            beforeSignedUrl:
              typeof json.before_signed_url === "string"
                ? json.before_signed_url
                : null,
          });
          return;
        }
        // 401 not_signed_in: pop the existing SignInModal in-place
        // instead of routing away. The modal captures the current
        // pathname as returnTo so the magic-link lands the user back
        // on /cassdimicconew automatically.
        if (json.error === "not_signed_in") {
          setRender({ state: "idle" });
          setShowSignIn(true);
          return;
        }
        const reason: BlockReason =
          json.error === "age_not_verified" ||
          json.error === "no_photo" ||
          json.error === "no_quota" ||
          json.error === "moderation_blocked"
            ? (json.error as BlockReason)
            : "render_failed";
        setRender({ state: "blocked", product, reason });
      } catch {
        setRender({ state: "blocked", product, reason: "render_failed" });
      }
    },
    [creatorSlug]
  );

  // ------------------------- outfit builder --------------------------
  // Toggle an item into / out of the outfit. Conflict rules:
  //   - At most one item per slot (top / bottom / dress / bag).
  //   - dress is exclusive with top + bottom (can't wear both).
  //     Adding a dress clears top and bottom; adding a top or bottom
  //     clears any existing dress.
  //   - Hard cap of MAX_OUTFIT_ITEMS total so the chained FASHN
  //     render stays under the maxDuration=300s budget.
  const toggleOutfit = useCallback((product: Product) => {
    const slot = slotFor(product);
    if (!slot) return; // non-eligible cards never reach here, but defensive
    setOutfit((prev) => {
      const next: Partial<Record<OutfitSlot, Product>> = { ...prev };
      // Removing the currently-selected item from this slot.
      if (next[slot]?.id === product.id) {
        delete next[slot];
        return next;
      }
      // Adding: resolve conflicts first.
      if (slot === "dress") {
        delete next.top;
        delete next.bottom;
      } else if (slot === "top" || slot === "bottom") {
        delete next.dress;
      }
      // Cap check. If at cap and this slot is empty, refuse the add.
      // (If the slot already has an item we replace it; net count is
      // unchanged so the cap is not violated.)
      const replacing = Boolean(next[slot]);
      const wouldExceed =
        !replacing && Object.keys(next).length >= MAX_OUTFIT_ITEMS;
      if (wouldExceed) return prev;
      next[slot] = product;
      return next;
    });
  }, []);

  const clearOutfit = useCallback(() => setOutfit({}), []);

  const outfitItems = useMemo(() => {
    // Stable display order in the tray: top, bottom, dress, bag.
    const order: OutfitSlot[] = ["top", "bottom", "dress", "bag"];
    return order
      .map((s) => outfit[s])
      .filter((p): p is Product => Boolean(p));
  }, [outfit]);

  const isInOutfit = useCallback(
    (product: Product): boolean => {
      const s = slotFor(product);
      return s ? outfit[s]?.id === product.id : false;
    },
    [outfit]
  );

  const runOutfitRender = useCallback(async () => {
    if (outfitItems.length === 0) return;
    setOutfitRender({ state: "loading", products: outfitItems });
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "outfit",
          creatorSlug,
          items: outfitItems.map((p) => ({
            image_url: p.image_url,
            name: p.product_title,
            brand: p.brand ?? undefined,
            category: p.product_subcategory ?? undefined,
          })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 200 && json.signed_url) {
        setOutfitRender({
          state: "result",
          products: outfitItems,
          signedUrl: json.signed_url,
          beforeSignedUrl:
            typeof json.before_signed_url === "string"
              ? json.before_signed_url
              : null,
        });
        return;
      }
      if (json.error === "not_signed_in") {
        setOutfitRender({ state: "idle" });
        setShowSignIn(true);
        return;
      }
      const reason: BlockReason =
        json.error === "age_not_verified" ||
        json.error === "no_photo" ||
        json.error === "no_quota" ||
        json.error === "moderation_blocked"
          ? (json.error as BlockReason)
          : "render_failed";
      setOutfitRender({ state: "blocked", products: outfitItems, reason });
    } catch {
      setOutfitRender({
        state: "blocked",
        products: outfitItems,
        reason: "render_failed",
      });
    }
  }, [outfitItems, creatorSlug]);

  // ------------------------- bottom search ---------------------------
  const onSearchSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setAppliedQuery(searchQuery.trim());
    },
    [searchQuery]
  );

  // ------------------------- render ----------------------------------
  const totalAll = useMemo(
    () => categories.reduce((n, c) => n + c.count, 0),
    [categories]
  );

  return (
    <div className="tryon-page">
      <header className="tryon-header">
        <div className="tryon-header-eyebrow">{signedIn ? "Welcome back" : "Try-on grid"}</div>
        <h1 className="tryon-header-title">{creatorName}</h1>
        {creatorBio ? <p className="tryon-header-bio">{creatorBio}</p> : null}
      </header>

      <nav className="tryon-pills" aria-label="Filter by category">
        <button
          type="button"
          className={`tryon-pill ${activeCategory === "all" ? "is-active" : ""}`}
          onClick={() => setActiveCategory("all")}
        >
          All {totalAll ? <span className="tryon-pill-count">{totalAll}</span> : null}
        </button>
        {categories.map((c) => (
          <button
            type="button"
            key={c.key}
            className={`tryon-pill ${activeCategory === c.key ? "is-active" : ""}`}
            onClick={() => setActiveCategory(c.key)}
          >
            {c.label} <span className="tryon-pill-count">{c.count}</span>
          </button>
        ))}
      </nav>

      {interpreted && interpreted.caption ? (
        <div className="tryon-interpreted" role="status" aria-live="polite">
          <span className="tryon-interpreted-label">Showing</span>
          <strong>{interpreted.caption}</strong>
          {interpreted.relaxed !== "none" && interpreted.relaxed !== "all" ? (
            <span className="tryon-interpreted-relaxed">
              (broadened from your search)
            </span>
          ) : null}
        </div>
      ) : null}

      <main className="tryon-grid">
        {products.map((p) => (
          <ProductCard
            key={p.id}
            product={p}
            onTryOn={onTryOn}
            tryOnEligible={isEligibleForTryOn(p)}
            inOutfit={isInOutfit(p)}
            onToggleOutfit={toggleOutfit}
          />
        ))}
        {products.length === 0 && !loadingPage ? (
          <p className="tryon-empty">
            No products
            {appliedQuery ? ` for "${appliedQuery}"` : ""}
            {activeCategory !== "all" ? " in this category" : ""}.
            {appliedQuery ? " Try a shorter query." : ""}
          </p>
        ) : null}
      </main>

      <div ref={sentinelRef} className="tryon-sentinel" aria-hidden>
        {loadingPage && hasMore ? "Loading more…" : null}
      </div>

      <form className="tryon-asker" onSubmit={onSearchSubmit}>
        <input
          className="tryon-asker-input"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          placeholder="ask for something specific…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button type="submit" className="tryon-asker-submit" aria-label="Search">
          ↵
        </button>
      </form>

      {render.state !== "idle" ? (
        <TryOnModal state={render} onClose={() => setRender({ state: "idle" })} />
      ) : null}

      {outfitItems.length > 0 ? (
        <OutfitTray
          items={outfitItems}
          onClear={clearOutfit}
          onRemove={toggleOutfit}
          onRender={runOutfitRender}
          rendering={outfitRender.state === "loading"}
        />
      ) : null}

      {outfitRender.state !== "idle" ? (
        <OutfitModal
          state={outfitRender}
          onClose={() => setOutfitRender({ state: "idle" })}
        />
      ) : null}

      {showSignIn ? (
        <SignInModal
          onClose={() => setShowSignIn(false)}
          title="Sign in to try it on"
          subtitle="One-tap email link. We'll bring you right back here."
        />
      ) : null}
    </div>
  );
}

function ProductCard({
  product,
  onTryOn,
  tryOnEligible,
  inOutfit,
  onToggleOutfit,
}: {
  product: Product;
  onTryOn: (p: Product) => void;
  tryOnEligible: boolean;
  inOutfit: boolean;
  onToggleOutfit: (p: Product) => void;
}) {
  const onShop = useCallback(() => {
    // Open the byte-for-byte stored affiliate URL. NEVER massage it;
    // every tracking param is the creator's attribution.
    window.open(product.affiliate_url, "_blank", "noopener,noreferrer");
  }, [product.affiliate_url]);

  return (
    <article className={`tryon-card ${inOutfit ? "is-in-outfit" : ""}`}>
      <div className="tryon-card-image-wrap">
        {tryOnEligible ? (
          <button
            type="button"
            className={`tryon-card-select ${inOutfit ? "is-selected" : ""}`}
            aria-pressed={inOutfit}
            aria-label={inOutfit ? "Remove from outfit" : "Add to outfit"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleOutfit(product);
            }}
          >
            {inOutfit ? "✓" : "+"}
          </button>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="tryon-card-image"
          src={product.image_url}
          alt={product.product_title}
          loading="lazy"
          decoding="async"
        />
      </div>
      <div className="tryon-card-meta">
        {product.brand ? <div className="tryon-card-brand">{product.brand}</div> : null}
        <div className="tryon-card-title">{product.product_title}</div>
        {product.price_display ? (
          <div className="tryon-card-price">{product.price_display}</div>
        ) : null}
      </div>
      <div className="tryon-card-actions">
        {tryOnEligible ? (
          <button
            type="button"
            className="tryon-btn tryon-btn-primary"
            onClick={() => onTryOn(product)}
          >
            Try This On
          </button>
        ) : null}
        <button
          type="button"
          className={`tryon-btn ${tryOnEligible ? "tryon-btn-secondary" : "tryon-btn-primary"}`}
          onClick={onShop}
        >
          Shop
        </button>
      </div>
    </article>
  );
}

/**
 * Sticky bottom tray showing the in-progress outfit. Lives above
 * the search asker bar so neither obscures the other. Each
 * thumbnail click removes that item from the outfit.
 */
function OutfitTray({
  items,
  onClear,
  onRemove,
  onRender,
  rendering,
}: {
  items: Product[];
  onClear: () => void;
  onRemove: (p: Product) => void;
  onRender: () => void;
  rendering: boolean;
}) {
  return (
    <div className="tryon-outfit-tray" role="region" aria-label="Outfit builder">
      <div className="tryon-outfit-thumbs">
        {items.map((p) => (
          <button
            key={p.id}
            type="button"
            className="tryon-outfit-thumb"
            aria-label={`Remove ${p.product_title} from outfit`}
            onClick={() => onRemove(p)}
            title={`${p.brand ? p.brand + " " : ""}${p.product_title} (tap to remove)`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.image_url} alt="" loading="lazy" decoding="async" />
            <span className="tryon-outfit-thumb-x" aria-hidden>
              ✕
            </span>
          </button>
        ))}
      </div>
      <div className="tryon-outfit-actions">
        <button
          type="button"
          className="tryon-btn tryon-btn-ghost"
          onClick={onClear}
          disabled={rendering}
        >
          Clear
        </button>
        <button
          type="button"
          className="tryon-btn tryon-btn-primary"
          onClick={onRender}
          disabled={rendering}
        >
          {rendering ? "Rendering…" : `Try on this outfit (${items.length})`}
        </button>
      </div>
    </div>
  );
}

/**
 * Outfit render modal. Mirrors TryOnModal's structure but lists all
 * items in the outfit on success so each one keeps its own Shop
 * button with byte-for-byte affiliate URL preserved.
 */
function OutfitModal({
  state,
  onClose,
}: {
  state: Exclude<OutfitRender, { state: "idle" }>;
  onClose: () => void;
}) {
  const titleList = state.products
    .map((p) => `${p.brand ? p.brand + " " : ""}${p.product_title}`)
    .join(", ");

  return (
    <div className="tryon-modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="tryon-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tryon-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
        {state.state === "loading" ? (
          <div className="tryon-modal-body tryon-modal-loading">
            <RenderLoadingState
              thumbnails={state.products.map((p) => ({
                src: p.image_url,
                alt: p.product_title,
              }))}
              garmentLabel="your outfit"
              expectedSeconds={state.products.length * 18}
              loaded={false}
            />
          </div>
        ) : null}
        {state.state === "result" ? (
          <div className="tryon-modal-body">
            <BeforeAfterReveal
              beforeUrl={state.beforeSignedUrl}
              afterUrl={state.signedUrl}
              alt="Outfit try-on"
            />
            <div className="tryon-modal-caption">{titleList}</div>
            <ResultActions
              beforeUrl={state.beforeSignedUrl}
              afterUrl={state.signedUrl}
              shareTitle="My AskMai outfit · askmai.co"
              shopUrl={null}
              shopLabel={null}
            />
            <div className="tryon-outfit-result-shops">
              {state.products.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="tryon-outfit-result-shop"
                  onClick={() =>
                    window.open(
                      p.affiliate_url,
                      "_blank",
                      "noopener,noreferrer"
                    )
                  }
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.image_url} alt="" loading="lazy" />
                  <span className="tryon-outfit-result-shop-label">
                    Shop{p.brand ? ` ${p.brand}` : ""}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {state.state === "blocked" ? (
          <div className="tryon-modal-body tryon-modal-blocked">
            <h2>{REASON_COPY[state.reason].title}</h2>
            <p>{REASON_COPY[state.reason].body}</p>
            {REASON_COPY[state.reason].cta ? (
              <a
                className="tryon-btn tryon-btn-primary"
                href={REASON_COPY[state.reason].cta!.href}
              >
                {REASON_COPY[state.reason].cta!.label}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Save (side-by-side PNG) + Share (animated reveal video) + Shop.
 * Both export actions are pure client-side via canvas + MediaRecorder
 * (see beforeAfter.ts). Falls back gracefully:
 *   - Save: works as long as the before URL is present.
 *   - Share: native share API when present (mobile), download link
 *     fallback otherwise (desktop). Hidden entirely when
 *     MediaRecorder isn't available in the browser.
 *   - Shop: stays wired to the affiliate URL with no rewriting.
 */
function ResultActions({
  beforeUrl,
  afterUrl,
  shareTitle,
  shopUrl,
  shopLabel,
}: {
  beforeUrl: string | null;
  afterUrl: string;
  shareTitle: string;
  shopUrl: string | null;
  shopLabel: string | null;
}) {
  const [working, setWorking] = useState<"" | "save" | "share">("");
  const canRecord =
    typeof window !== "undefined" && recorderMimeAvailable();

  const onSave = useCallback(async () => {
    if (!beforeUrl || working) return;
    setWorking("save");
    try {
      const blob = await composeSideBySide(beforeUrl, afterUrl);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "askmai-tryon.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      console.warn("[tryon] side-by-side save failed", e);
      // Fall back to a direct download of the after image so the
      // Save button never feels broken.
      const a = document.createElement("a");
      a.href = afterUrl;
      a.download = "askmai-tryon.png";
      a.click();
    } finally {
      setWorking("");
    }
  }, [beforeUrl, afterUrl, working]);

  const onShare = useCallback(async () => {
    if (!beforeUrl || working) return;
    setWorking("share");
    try {
      const blob = await composeRevealVideo(beforeUrl, afterUrl);
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `askmai-tryon.${ext}`, {
        type: blob.type,
      });
      // Native share with files where supported (mobile primarily).
      // navigator.canShare gates this; if files-share isn't supported,
      // fall through to a download.
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({
          files: [file],
          title: shareTitle,
          text: shareTitle,
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      }
    } catch (e) {
      // AbortError is the user cancelling the share sheet; not a real
      // failure. Other errors fall back to a download.
      const name = (e as { name?: string })?.name;
      if (name !== "AbortError") {
        console.warn("[tryon] share failed, retrying as download", e);
      }
    } finally {
      setWorking("");
    }
  }, [beforeUrl, afterUrl, shareTitle, working]);

  return (
    <div className="tryon-modal-actions">
      {beforeUrl ? (
        <button
          type="button"
          className="tryon-btn tryon-btn-secondary"
          onClick={onSave}
          disabled={working !== ""}
        >
          {working === "save" ? "Saving…" : "Save image"}
        </button>
      ) : (
        <a
          className="tryon-btn tryon-btn-secondary"
          href={afterUrl}
          download="askmai-tryon.png"
        >
          Save image
        </a>
      )}
      {beforeUrl && canRecord ? (
        <button
          type="button"
          className="tryon-btn tryon-btn-secondary"
          onClick={onShare}
          disabled={working !== ""}
        >
          {working === "share" ? "Recording…" : "Share"}
        </button>
      ) : null}
      {shopUrl && shopLabel ? (
        <button
          type="button"
          className="tryon-btn tryon-btn-primary"
          onClick={() =>
            window.open(shopUrl, "_blank", "noopener,noreferrer")
          }
        >
          {shopLabel}
        </button>
      ) : null}
    </div>
  );
}

function TryOnModal({
  state,
  onClose,
}: {
  state: Exclude<RenderResult, { state: "idle" }>;
  onClose: () => void;
}) {
  return (
    <div className="tryon-modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="tryon-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tryon-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
        {state.state === "loading" ? (
          <div className="tryon-modal-body tryon-modal-loading">
            <RenderLoadingState
              thumbnails={[
                { src: state.product.image_url, alt: state.product.product_title },
              ]}
              garmentLabel={
                state.product.brand
                  ? `${state.product.brand} ${state.product.product_title}`
                  : state.product.product_title
              }
              expectedSeconds={60}
              loaded={false}
            />
          </div>
        ) : null}
        {state.state === "result" ? (
          <div className="tryon-modal-body">
            <BeforeAfterReveal
              beforeUrl={state.beforeSignedUrl}
              afterUrl={state.signedUrl}
              alt={state.product.product_title}
            />
            <div className="tryon-modal-caption">
              {state.product.brand ? `${state.product.brand} · ` : ""}
              {state.product.product_title}
            </div>
            <ResultActions
              beforeUrl={state.beforeSignedUrl}
              afterUrl={state.signedUrl}
              shareTitle={`${state.product.brand ? state.product.brand + " " : ""}${state.product.product_title} · askmai.co`}
              shopUrl={state.product.affiliate_url}
              shopLabel="Shop the piece"
            />
          </div>
        ) : null}
        {state.state === "blocked" ? (
          <div className="tryon-modal-body tryon-modal-blocked">
            <h2>{REASON_COPY[state.reason].title}</h2>
            <p>{REASON_COPY[state.reason].body}</p>
            {REASON_COPY[state.reason].cta ? (
              <a
                className="tryon-btn tryon-btn-primary"
                href={REASON_COPY[state.reason].cta!.href}
              >
                {REASON_COPY[state.reason].cta!.label}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
