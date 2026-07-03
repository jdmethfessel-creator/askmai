"use client";

/**
 * Shared product card. Single source of truth for the Shop grid and
 * the Ask chat (so Ask responses use the same affordances and look
 * as Shop, not a bespoke chat-local card variant).
 *
 * Button rules:
 *   - "+" (save to Try On) — apparel-only (tops/bottoms/dresses/
 *     outerwear). Eligibility comes from the strict allow-list in
 *     _tryon/outfit.ts so it stays aligned with the server-side
 *     RENDERABLE_SUBCATEGORIES gate in src/lib/render.ts. Beauty,
 *     bags, shoes, jewelry, accessories, swim, home never get the
 *     "+" — they show Shop only.
 *   - "Try This On" — same apparel-only gate. Fires a single-item
 *     render through /api/render.
 *   - "Shop" — always shown. Opens product.affiliate_url
 *     byte-for-byte (creator attribution preservation).
 *
 * Image safety net: if the image fails to load the whole card
 * unmounts so the grid reflows around it and no broken-image glyph
 * ever paints. Hooks are declared above the early return so order
 * stays stable across renders.
 *
 * Edit mode (Shop only): renders the featured ★/☆ toggle on the
 * top-left of the image. Chat passes editMode={false} so the chat
 * surface never shows this affordance even when JD is in edit mode
 * for Shop.
 */

import { useCallback, useState } from "react";

export type Product = {
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
  featured: boolean | null;
  on_sale?: boolean | null;
  compare_at_price?: number | null;
  mai_note?: string | null;
};

export type ProductCardProps = {
  product: Product;
  onTryOn: (p: Product) => void;
  tryOnEligible: boolean;
  /** Whether this card is in the user's Try On collection. The "+"
   *  flips to "✓" when true; tap again removes. Only apparel cards
   *  show the affordance at all (gated by tryOnEligible). */
  saved: boolean;
  onToggleSave: (p: Product) => void;
  /** Pre-computed possessive form ("Jane's") for the edit-mode star
   *  tooltip. Falls back to "her" upstream when unset. */
  creatorPossessive: string;
  /** Default false. Shop sets true when the operator is in
   *  edit-mode (admin cookie); chat always passes false. */
  editMode?: boolean;
  /** Optimistic featured state set by the local toggle handler;
   *  undefined means "use product.featured from the API response."
   *  Ignored when editMode=false. */
  featuredOverride?: boolean;
  onToggleFeatured?: (p: Product) => void;
};

export function ProductCard({
  product,
  onTryOn,
  tryOnEligible,
  saved,
  onToggleSave,
  creatorPossessive,
  editMode = false,
  featuredOverride,
  onToggleFeatured,
}: ProductCardProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const onShop = useCallback(() => {
    // Open the byte-for-byte stored affiliate URL. NEVER massage it;
    // every tracking param is the creator's attribution.
    window.open(product.affiliate_url, "_blank", "noopener,noreferrer");
  }, [product.affiliate_url]);
  if (imageFailed) return null;

  const isFeatured =
    typeof featuredOverride === "boolean"
      ? featuredOverride
      : Boolean(product.featured);

  return (
    <article
      className={`tryon-card ${saved ? "is-in-outfit" : ""} ${editMode && isFeatured ? "is-featured" : ""}`}
    >
      <div className="tryon-card-image-wrap">
        {editMode && onToggleFeatured ? (
          <button
            type="button"
            className={`tryon-card-feature ${isFeatured ? "is-on" : ""}`}
            aria-pressed={isFeatured}
            aria-label={isFeatured ? "Unfeature this item" : "Feature this item"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFeatured(product);
            }}
            title={
              isFeatured
                ? `In ${creatorPossessive} picks`
                : `Add to ${creatorPossessive} picks`
            }
          >
            {isFeatured ? "★" : "☆"}
          </button>
        ) : null}
        {tryOnEligible ? (
          <button
            type="button"
            className={`tryon-card-select ${saved ? "is-selected" : ""}`}
            aria-pressed={saved}
            aria-label={saved ? "Remove from Try On" : "Add to Try On"}
            title={saved ? "Saved · tap to remove" : "Save to Try On"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSave(product);
            }}
          >
            {saved ? "✓" : "+"}
          </button>
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="tryon-card-image"
          src={product.image_url}
          alt={product.product_title}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      </div>
      {product.on_sale ? (
        <span className="ps-hang-corner ps-hang-corner-sale">on sale</span>
      ) : null}
      <div className="tryon-card-meta">
        {product.brand ? (
          <div className="tryon-card-brand">{product.brand}</div>
        ) : null}
        <div className="tryon-card-title">{product.product_title}</div>
        {product.price_display || product.price != null ? (
          <div className="tryon-card-price">
            {product.on_sale &&
            typeof product.compare_at_price === "number" &&
            product.price != null &&
            product.compare_at_price > product.price ? (
              <span
                style={{
                  textDecoration: "line-through",
                  color: "var(--ink-soft)",
                  marginRight: 6,
                  fontWeight: 500,
                  fontSize: 11,
                }}
              >
                ${Math.round(product.compare_at_price)}
              </span>
            ) : null}
            {product.price_display ??
              (product.price != null ? `$${Math.round(product.price)}` : "")}
          </div>
        ) : null}
        {product.mai_note ? (
          <p className="ps-mai-note">{product.mai_note}</p>
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
