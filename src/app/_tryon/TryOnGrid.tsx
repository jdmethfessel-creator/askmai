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
  | { state: "result"; product: Product; signedUrl: string }
  | { state: "blocked"; product: Product; reason: BlockReason };

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
              },
            ],
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 200 && json.signed_url) {
          setRender({ state: "result", product, signedUrl: json.signed_url });
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
          <ProductCard key={p.id} product={p} onTryOn={onTryOn} />
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
}: {
  product: Product;
  onTryOn: (p: Product) => void;
}) {
  const onShop = useCallback(() => {
    // Open the byte-for-byte stored affiliate URL. NEVER massage it —
    // every tracking param is the creator's attribution.
    window.open(product.affiliate_url, "_blank", "noopener,noreferrer");
  }, [product.affiliate_url]);

  return (
    <article className="tryon-card">
      <div className="tryon-card-image-wrap">
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
        <button
          type="button"
          className="tryon-btn tryon-btn-primary"
          onClick={() => onTryOn(product)}
        >
          Try This On
        </button>
        <button
          type="button"
          className="tryon-btn tryon-btn-secondary"
          onClick={onShop}
        >
          Shop
        </button>
      </div>
    </article>
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
            <div className="tryon-spinner" />
            <p>Rendering “{state.product.product_title}” on your photo…</p>
            <p className="tryon-modal-sub">~60 seconds. Stay on this tab.</p>
          </div>
        ) : null}
        {state.state === "result" ? (
          <div className="tryon-modal-body">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="tryon-modal-image" src={state.signedUrl} alt="" />
            <div className="tryon-modal-caption">
              {state.product.brand ? `${state.product.brand} — ` : ""}
              {state.product.product_title}
            </div>
            <div className="tryon-modal-actions">
              <a
                className="tryon-btn tryon-btn-secondary"
                href={state.signedUrl}
                download
              >
                Save image
              </a>
              <button
                type="button"
                className="tryon-btn tryon-btn-primary"
                onClick={() =>
                  window.open(
                    state.product.affiliate_url,
                    "_blank",
                    "noopener,noreferrer"
                  )
                }
              >
                Shop the piece
              </button>
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
