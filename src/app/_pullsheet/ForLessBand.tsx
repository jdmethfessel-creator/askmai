"use client";

/**
 * ForLessBand - fetches /api/for-less/:productId and renders a
 * "For less, from her closet" strip of up to 3 mini hang tags.
 * Renders nothing when the anchor doesn't qualify or the endpoint
 * comes back empty, so the surface stays invisible when there's
 * nothing to say.
 *
 * Every affiliate URL fired from these tags opens byte-for-byte
 * per the invariant.
 */

import { useEffect, useState } from "react";

type ForLessRow = {
  id: string;
  source_network: string;
  product_title: string;
  brand: string | null;
  price: number | null;
  price_display: string | null;
  image_url: string;
  affiliate_url: string;
};

function networkLabel(network: string): string {
  const s = network.trim().toLowerCase();
  if (s === "shopmy") return "ShopMy";
  if (s === "shopbop") return "Shopbop";
  if (s === "revolve") return "Revolve";
  if (s === "fwrd") return "FWRD";
  return network || "";
}

function formatPrice(row: ForLessRow): string {
  if (row.price_display && row.price_display.trim()) return row.price_display.trim();
  if (row.price != null) return `$${Math.round(row.price)}`;
  return "";
}

export default function ForLessBand({ productId }: { productId: string }) {
  const [rows, setRows] = useState<ForLessRow[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetch(`/api/for-less/${encodeURIComponent(productId)}`, {
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        if (j?.qualifies && Array.isArray(j?.candidates) && j.candidates.length > 0) {
          setRows(j.candidates as ForLessRow[]);
        } else {
          setRows([]);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setRows([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [productId]);

  if (!loaded || !rows || rows.length === 0) return null;

  return (
    <section className="ps-forless">
      <hr className="ps-rule" />
      <h4 className="ps-forless-title">For less, from her closet</h4>
      <ul className="ps-forless-list">
        {rows.map((r) => (
          <li key={r.id}>
            <a
              className="ps-hang-mini"
              href={r.affiliate_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={r.image_url}
                alt=""
                className="ps-hang-mini-img"
                loading="lazy"
                decoding="async"
              />
              <div className="ps-hang-mini-meta">
                <span className="ps-hang-mini-name">{r.product_title}</span>
                <div className="ps-hang-mini-row">
                  <span className="ps-hang-mini-network">
                    {networkLabel(r.source_network)}
                  </span>
                  <span className="ps-hang-mini-price">{formatPrice(r)}</span>
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>

      <style jsx>{`
        .ps-forless {
          margin: 12px 0 4px;
        }
        .ps-forless-title {
          font-family: var(--font-display);
          font-style: italic;
          font-weight: 500;
          font-size: 16px;
          margin: 6px 0 8px;
          color: var(--ink);
          letter-spacing: -0.005em;
        }
        .ps-forless-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: grid;
          gap: 8px;
        }
        .ps-forless-list :global(.ps-hang-mini) {
          text-decoration: none;
          color: inherit;
        }
      `}</style>
    </section>
  );
}
