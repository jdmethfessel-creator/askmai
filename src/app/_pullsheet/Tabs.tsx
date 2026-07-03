"use client";

/**
 * Tabs - Shop / Ask / Try On rail. Uppercase tracked labels sitting
 * on a 1.5px ink baseline rule; active tab gets a 1.5px ink border
 * box that reads as a garment tab on the rule.
 */

export type TabItem = { key: string; label: string };

export default function Tabs({
  items,
  active,
  onChange,
}: {
  items: TabItem[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="ps-tabs" role="tablist">
      {items.map((it) => (
        <button
          key={it.key}
          role="tab"
          type="button"
          className="ps-tab"
          aria-selected={active === it.key}
          onClick={() => onChange(it.key)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
