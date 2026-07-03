"use client";

/**
 * SearchFilters - renders the active hard filters derived from
 * parseQuery (category, colors, priceMax) as removable chips.
 * Removing a chip fires onRemove with the filter key so the parent
 * can rewrite the query.
 */

export type ActiveFilters = {
  category: string | null;
  colors: string[];
  priceMax: number | null;
};

export default function SearchFilters({
  filters,
  onRemove,
}: {
  filters: ActiveFilters;
  onRemove: (kind: "category" | "color" | "price", value?: string) => void;
}) {
  const chips: Array<{ key: string; label: string; kind: "category" | "color" | "price"; value?: string }> = [];
  if (filters.category) {
    chips.push({
      key: `cat:${filters.category}`,
      label: filters.category,
      kind: "category",
    });
  }
  for (const c of filters.colors) {
    chips.push({
      key: `color:${c}`,
      label: c.replace("-", " "),
      kind: "color",
      value: c,
    });
  }
  if (filters.priceMax != null) {
    chips.push({
      key: "price",
      label: `under $${filters.priceMax}`,
      kind: "price",
    });
  }
  if (chips.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        gap: 6,
        flexWrap: "wrap",
        padding: "10px 12px 4px",
      }}
    >
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className="ps-chip is-on"
          onClick={() => onRemove(c.kind, c.value)}
          aria-label={`Remove ${c.label}`}
          style={{ cursor: "pointer" }}
        >
          {c.label}
          <span
            aria-hidden
            style={{ marginLeft: 6, fontSize: 9, opacity: 0.85 }}
          >
            ✕
          </span>
        </button>
      ))}
    </div>
  );
}
