"use client";

/**
 * OnSaleRail - shown above the Shop grid whenever the currently
 * loaded products include on-sale items. Best-effort: derives from
 * the products already loaded rather than a separate fetch, so a
 * fresh environment (no on_sale column) simply renders nothing.
 *
 * Each rail item opens the byte-for-byte affiliate URL.
 */

export type OnSaleItem = {
  id: string;
  source_network: string;
  product_title: string;
  image_url: string;
  affiliate_url: string;
  price: number | null;
  compare_at_price: number | null;
};

function fmt(n: number | null): string {
  if (n == null) return "";
  return `$${Math.round(n)}`;
}

export default function OnSaleRail({ items }: { items: OnSaleItem[] }) {
  if (!items || items.length === 0) return null;
  return (
    <section className="ps-sale-rail">
      <h3 className="ps-sale-rail-title">On sale in her closet</h3>
      <ul className="ps-sale-rail-list">
        {items.map((it) => (
          <li key={it.id}>
            <a
              className="ps-sale-rail-item"
              href={it.affiliate_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.image_url}
                alt={it.product_title}
                loading="lazy"
                decoding="async"
              />
              <div className="ps-sale-rail-meta">
                <span className="ps-sale-rail-name">{it.product_title}</span>
                <span className="ps-sale-rail-price">
                  {it.compare_at_price != null &&
                  it.price != null &&
                  it.compare_at_price > it.price ? (
                    <span className="ps-sale-rail-was">
                      {fmt(it.compare_at_price)}
                    </span>
                  ) : null}
                  {fmt(it.price)}
                </span>
              </div>
            </a>
          </li>
        ))}
      </ul>

      <style jsx>{`
        .ps-sale-rail {
          border-top: 1.5px solid var(--ink);
          border-bottom: 1px solid var(--line);
          padding: 14px 16px;
          background: var(--card);
          margin: 12px 0 0;
        }
        .ps-sale-rail-title {
          font-family: var(--font-display);
          font-style: italic;
          font-weight: 500;
          font-size: 18px;
          margin: 0 0 10px;
          color: var(--ink);
          letter-spacing: -0.005em;
        }
        .ps-sale-rail-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          gap: 12px;
          overflow-x: auto;
        }
        .ps-sale-rail-item {
          flex: 0 0 auto;
          display: block;
          width: 140px;
          text-decoration: none;
          color: inherit;
          background: #ffffff;
          border: 1px solid var(--ink);
          box-shadow: 2px 2px 0 var(--taupe);
          padding: 6px 6px 8px;
        }
        .ps-sale-rail-item img {
          display: block;
          width: 100%;
          aspect-ratio: 3 / 4;
          object-fit: cover;
          background: var(--card);
        }
        .ps-sale-rail-meta {
          padding: 6px 4px 0;
        }
        .ps-sale-rail-name {
          font-family: var(--font-display);
          font-weight: 700;
          font-size: 11px;
          line-height: 1.2;
          color: var(--ink);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .ps-sale-rail-price {
          display: block;
          margin-top: 4px;
          font-family: var(--font-body);
          font-size: 12px;
          font-weight: 700;
          color: var(--ink);
        }
        .ps-sale-rail-was {
          text-decoration: line-through;
          color: var(--ink-soft);
          font-weight: 500;
          margin-right: 6px;
        }
      `}</style>
    </section>
  );
}
