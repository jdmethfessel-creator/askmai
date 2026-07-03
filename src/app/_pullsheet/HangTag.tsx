"use client";

/**
 * HangTag - editorial product card in the pull-sheet system.
 * Punched-hole + string on top, name in Bodoni Moda bold, small
 * network + price row, and an optional Mai handwriting note.
 *
 * Renders the same Product shape as _tryon/ProductCard so callers
 * can swap this in without changing their data flow. Affiliate URL
 * opens byte-for-byte via `window.open(product.affiliate_url)` per
 * the invariant.
 */

import { useCallback, useState } from "react";
import MaiNote from "./MaiNote";

export type HangTagProduct = {
  id: string;
  source_network: string;
  product_title: string;
  brand: string | null;
  price: number | null;
  price_display: string | null;
  image_url: string;
  affiliate_url: string;
  product_category?: string | null;
  product_subcategory?: string | null;
  featured?: boolean | null;
  mai_note?: string | null;
  on_sale?: boolean | null;
  compare_at_price?: number | null;
  has_for_less?: boolean | null;
};

export type HangTagProps = {
  product: HangTagProduct;
  onTryOn?: (p: HangTagProduct) => void;
  tryOnEligible?: boolean;
  saved?: boolean;
  onToggleSave?: (p: HangTagProduct) => void;
  onWatch?: (p: HangTagProduct) => void;
  watching?: boolean;
};

function formatPrice(n: number | null | undefined, display?: string | null): string {
  if (display && display.trim()) return display.trim();
  if (n == null) return "";
  return `$${Math.round(n)}`;
}

function networkLabel(network: string): string {
  const s = network.trim().toLowerCase();
  if (s === "shopmy") return "ShopMy";
  if (s === "shopbop") return "Shopbop";
  if (s === "revolve") return "Revolve";
  if (s === "fwrd") return "FWRD";
  return network || "";
}

export default function HangTag({
  product,
  onTryOn,
  tryOnEligible = false,
  saved = false,
  onToggleSave,
  onWatch,
  watching = false,
}: HangTagProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const onShop = useCallback(() => {
    // BYTE-FOR-BYTE affiliate URL. Never modify.
    window.open(product.affiliate_url, "_blank", "noopener,noreferrer");
  }, [product.affiliate_url]);

  if (imageFailed) return null;

  const hasCompareAt =
    product.on_sale &&
    typeof product.compare_at_price === "number" &&
    product.compare_at_price > (product.price ?? 0);

  return (
    <article className="ps-hang">
      <span className="ps-hang-string" aria-hidden />
      <span className="ps-hang-hole" aria-hidden />

      {product.on_sale ? (
        <span className="ps-hang-corner ps-hang-corner-sale">on sale</span>
      ) : product.has_for_less ? (
        <span className="ps-hang-corner">for less</span>
      ) : null}

      <div className="ps-hang-image-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={product.image_url}
          alt={product.product_title}
          loading="lazy"
          decoding="async"
          className="ps-hang-image"
          onError={() => setImageFailed(true)}
        />
        {tryOnEligible && onToggleSave ? (
          <button
            type="button"
            className="ps-btn ps-btn-icon ps-btn-secondary"
            aria-pressed={saved}
            aria-label={saved ? "Remove from Try On" : "Save to Try On"}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSave(product);
            }}
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              zIndex: 2,
              fontSize: 14,
              letterSpacing: 0,
            }}
          >
            {saved ? "✓" : "+"}
          </button>
        ) : null}
      </div>

      <h3 className="ps-hang-name">{product.product_title}</h3>

      <div className="ps-hang-row">
        <span className="ps-hang-network">{networkLabel(product.source_network)}</span>
        <span className="ps-hang-price">
          {hasCompareAt ? (
            <span className="ps-hang-price-was">
              {formatPrice(product.compare_at_price ?? null)}
            </span>
          ) : null}
          {formatPrice(product.price, product.price_display)}
        </span>
      </div>

      {product.mai_note ? <MaiNote>{product.mai_note}</MaiNote> : null}

      <div className="ps-hang-actions">
        {tryOnEligible && onTryOn ? (
          <button
            type="button"
            className="ps-btn ps-btn-primary"
            style={{ flex: 1 }}
            onClick={() => onTryOn(product)}
          >
            Try on
          </button>
        ) : null}
        <button
          type="button"
          className={`ps-btn ${tryOnEligible ? "ps-btn-secondary" : "ps-btn-primary"}`}
          style={{ flex: 1 }}
          onClick={onShop}
        >
          Shop
        </button>
        {onWatch ? (
          <button
            type="button"
            className="ps-btn ps-btn-secondary ps-btn-icon"
            aria-pressed={watching}
            aria-label={watching ? "Watching price" : "Watch price"}
            title={watching ? "Watching price" : "Watch price"}
            onClick={(e) => {
              e.stopPropagation();
              onWatch(product);
            }}
          >
            {watching ? "◆" : "◇"}
          </button>
        ) : null}
      </div>
    </article>
  );
}
