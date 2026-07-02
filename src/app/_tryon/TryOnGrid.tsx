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
  isTryOnEligibleSubcategory,
} from "./outfit";
import {
  addItem as addItemToRoom,
  loadDressingRoom,
  removeItem as removeItemFromRoom,
} from "./dressingRoomStore";
import { REASON_COPY, ResultActions, type BlockReason } from "./renderShared";
import { ProductCard, type Product } from "./ProductCard";

// `Product` type lives in ./ProductCard so the Ask chat can adapt
// its model-emitted `Rec` shape into the same shared interface.
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

// Per-card eligibility for the body-render Try-On button (see
// _tryon/outfit.ts for the shared rules). Items outside tops /
// bottoms / dresses / outerwear show Shop only on the grid.
// The DressingRoom tab also surfaces non-tryable saved items but
// disables them from multi-select renders.

function isEligibleForTryOn(product: Product): boolean {
  return isTryOnEligibleSubcategory(product.product_subcategory);
}

const PAGE_SIZE = 40;

// Possessive form for the scope banner + edit-mode tooltips. Single
// shared helper so every callsite reads the same way. Modern usage:
// just "{Name}'s" regardless of trailing-s (Strunk-style "Charles's"
// over the older "Charles'"), so we don't branch on the last letter.
// Falls back to a non-possessive "her" string when no name is passed
// so a missing prop never blanks the UI.
function creatorPossessive(name: string | undefined | null): string {
  const n = (name ?? "").trim();
  return n ? `${n}'s` : "her";
}

export default function TryOnGrid({
  creatorSlug,
  creatorFirstName,
  signedIn,
  editMode = false,
  initialRecent = false,
}: {
  creatorSlug: string;
  /** First name only, used for the scope banner ("Showing Jane's
   *  recent picks") + edit-mode star tooltips ("Add to Jane's
   *  picks"). The page server-component derives it from
   *  creators.name. */
  creatorFirstName?: string;
  signedIn: boolean;
  /** Phase-1 curation gate. When true, each card shows a star
   *  toggle that flips creator_products.featured. Activated via
   *  /api/admin/edit-mode?key=<ADMIN_EDIT_KEY>. */
  editMode?: boolean;
  /** Whether the page mounted with ?recent=1 (or the back-compat
   *  alias ?curated=1) — server filters to the last 90 days when
   *  true. Default false = full catalog. */
  initialRecent?: boolean;
}) {
  const possessive = creatorPossessive(creatorFirstName);
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
  // Set of product ids currently saved to this creator's Dressing
  // Room. Hydrated from localStorage on mount and kept in sync with
  // every + tap. The cross-tab `storage` event mirror means saving
  // an item in another tab updates the + state here too.
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());

  // Each fetch round bumps the token; in-flight responses for a stale
  // token are discarded. Prevents a slow first-page response from
  // overwriting the user's new filter selection.
  const fetchTokenRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Curated-view toggle. Default false = full catalog (tryable-
  // first then recency). When true, filter to the creator's
  // featured edit (with server-side fallback to the full catalog
  // if no rows are starred yet, so the page never goes blank).
  // Mirrors the ?curated=1 URL param.
  // Was previously "curated" (featured-only). Repurposed: when true,
  // the server filters to the last 90 days and sorts pure-recency.
  // URL flag accepts ?recent=1 (canonical) or ?curated=1 (back-compat
  // alias) so old links keep working.
  const [recent, setRecent] = useState<boolean>(initialRecent);
  // Local optimistic mirror of each card's featured flag so the
  // star toggle reads in real-time without a full grid refetch.
  // Keyed by product id.
  const [featuredOverride, setFeaturedOverride] = useState<
    Record<string, boolean>
  >({});

  // Session id for tryon_events. Generated once per page load,
  // not persisted, no PII. Lets us reconstruct start->complete
  // funnels in tryon_events.
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current && typeof crypto !== "undefined") {
    sessionIdRef.current = crypto.randomUUID();
  }

  const trackEvent = useCallback(
    (
      event:
        | "tryon_start"
        | "tryon_complete_ok"
        | "tryon_complete_fail",
      extra: {
        productExternalId?: string;
        productSubcategory?: string | null;
        outfitSize?: number;
        durationMs?: number;
        failureReason?: string;
      } = {}
    ) => {
      // Fire-and-forget; never blocks the UX. Errors silently
      // dropped (server logs them).
      try {
        fetch("/api/events/tryon", {
          method: "POST",
          headers: { "content-type": "application/json" },
          keepalive: true,
          body: JSON.stringify({
            event,
            creatorSlug,
            sessionId: sessionIdRef.current,
            ...extra,
            productSubcategory: extra.productSubcategory ?? undefined,
          }),
        }).catch(() => {});
      } catch {
        // crypto.randomUUID unavailable in very old engines, etc.
      }
    },
    [creatorSlug]
  );

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
        if (recent) params.set("recent", "1");
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
    [activeCategory, appliedQuery, creatorSlug, cursor, recent]
  );

  // Reset + first page whenever the filter, search, or curated-
  // view toggle changes.
  useEffect(() => {
    setProducts([]);
    setCursor(null);
    setHasMore(true);
    fetchPage({ reset: true });
    // intentionally exclude fetchPage from deps so it doesn't loop on
    // the page-cursor change cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategory, appliedQuery, creatorSlug, recent]);

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
      const startedAt = Date.now();
      trackEvent("tryon_start", {
        productExternalId: product.id,
        productSubcategory: product.product_subcategory,
        outfitSize: 1,
      });
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
          trackEvent("tryon_complete_ok", {
            productExternalId: product.id,
            productSubcategory: product.product_subcategory,
            outfitSize: 1,
            durationMs: Date.now() - startedAt,
          });
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
          // Not tracked as a failure: it's a routing event, not a
          // try-on outcome.
          return;
        }
        const reason: BlockReason =
          json.error === "age_not_verified" ||
          json.error === "no_photo" ||
          json.error === "no_quota" ||
          json.error === "moderation_blocked"
            ? (json.error as BlockReason)
            : "render_failed";
        trackEvent("tryon_complete_fail", {
          productExternalId: product.id,
          productSubcategory: product.product_subcategory,
          outfitSize: 1,
          durationMs: Date.now() - startedAt,
          failureReason: reason,
        });
        setRender({ state: "blocked", product, reason });
      } catch {
        trackEvent("tryon_complete_fail", {
          productExternalId: product.id,
          productSubcategory: product.product_subcategory,
          outfitSize: 1,
          durationMs: Date.now() - startedAt,
          failureReason: "network_error",
        });
        setRender({ state: "blocked", product, reason: "render_failed" });
      }
    },
    [creatorSlug, trackEvent]
  );

  // ------------------------- dressing room ---------------------------
  // Hydrate saved-ids on mount and re-hydrate on cross-tab storage
  // events. The actual data persistence is in dressingRoomStore.ts;
  // this state only mirrors which ids are saved so the + button can
  // flip to ✓ instantly.
  useEffect(() => {
    setSavedIds(new Set(loadDressingRoom(creatorSlug).items.map((i) => i.id)));
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (!e.key || !e.key.startsWith("askmai:dressing-room:")) return;
      setSavedIds(
        new Set(loadDressingRoom(creatorSlug).items.map((i) => i.id))
      );
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [creatorSlug]);

  const toggleSave = useCallback(
    (product: Product) => {
      // Defense in depth: the + button is only rendered on tryable
      // cards (see ProductCard), but guard here so a programmatic
      // call from anywhere else can't slip a non-apparel item into
      // the Room.
      if (!isEligibleForTryOn(product)) return;
      const alreadySaved = savedIds.has(product.id);
      if (alreadySaved) {
        removeItemFromRoom(creatorSlug, product.id);
        setSavedIds((prev) => {
          const next = new Set(prev);
          next.delete(product.id);
          return next;
        });
      } else {
        addItemToRoom(creatorSlug, {
          id: product.id,
          creatorSlug,
          name: product.product_title,
          brand: product.brand ?? null,
          imageUrl: product.image_url,
          affiliateUrl: product.affiliate_url,
          subcategory: product.product_subcategory ?? null,
          priceDisplay: product.price_display ?? null,
        });
        setSavedIds((prev) => {
          const next = new Set(prev);
          next.add(product.id);
          return next;
        });
      }
    },
    [creatorSlug, savedIds]
  );

  // ------------------------- featured toggle (Phase 1 edit mode) ----
  const toggleFeatured = useCallback(
    async (product: Product) => {
      if (!editMode) return;
      const currentFeatured = featuredOverride[product.id];
      const effective =
        currentFeatured ?? Boolean(product.featured);
      const nextFeatured = !effective;
      // Optimistic update so the star reacts instantly.
      setFeaturedOverride((prev) => ({ ...prev, [product.id]: nextFeatured }));
      try {
        const res = await fetch("/api/admin/feature-product", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            productId: product.id,
            featured: nextFeatured,
          }),
        });
        if (!res.ok) {
          // Roll back optimistic update on failure.
          setFeaturedOverride((prev) => ({
            ...prev,
            [product.id]: effective,
          }));
        }
      } catch {
        setFeaturedOverride((prev) => ({
          ...prev,
          [product.id]: effective,
        }));
      }
    },
    [editMode, featuredOverride]
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
      {/* Creator name + eyebrow + Shop/Ask toggle now live in the
          page-level shared header (see src/app/cassdimicconew/page.tsx)
          so the same DOM persists across mode flips. The body
          starts at the category pills. */}
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

      {/* Scope banner: default is the full catalog; clicking the
          toggle opts into her curated picks. Hidden when an active
          search query is showing its own interpreted caption, since
          the search caption already explains the scope. */}
      {!appliedQuery ? (
        <div className="tryon-scope-banner">
          <span className="tryon-scope-label">
            {recent
              ? `Showing ${possessive} recent picks`
              : `Showing ${possessive} full catalog`}
            {editMode ? (
              <span className="tryon-scope-edit-tag"> · EDIT MODE</span>
            ) : null}
          </span>
          <button
            type="button"
            className="tryon-scope-toggle"
            onClick={() => setRecent((v) => !v)}
          >
            {recent ? "See everything" : `See ${possessive} recent picks`} →
          </button>
        </div>
      ) : null}

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
            saved={savedIds.has(p.id)}
            onToggleSave={toggleSave}
            editMode={editMode}
            featuredOverride={featuredOverride[p.id]}
            onToggleFeatured={toggleFeatured}
            creatorPossessive={possessive}
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
