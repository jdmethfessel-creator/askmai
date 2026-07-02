"use client";

/**
 * FitRecPanel - renders size recommendations for a list of products.
 * Used under the try-on result image on both DressingRoom and
 * TryOnGrid. Fetches /api/fit-rec once for the given product ids,
 * then renders one line per product (or a compact form for single-
 * product renders).
 *
 * If the endpoint returns tier 0 for a product, we omit the line
 * entirely rather than show a placeholder. The tone rule (fit and
 * proportion only) is enforced by the engine's rationale composer;
 * this component just renders the string.
 */

import { useEffect, useState } from "react";

type FitRec = {
  size: string | null;
  confidence: "high" | "medium" | "low" | "none";
  rationale: string | null;
  model_line: string | null;
  tier: 0 | 1 | 2 | 3 | 4;
};

export default function FitRecPanel({
  items,
}: {
  items: Array<{ id: string; name: string; brand?: string | null }>;
}) {
  const [recs, setRecs] = useState<Record<string, FitRec> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const ids = items.map((i) => i.id).join(",");
    if (!ids) {
      setLoading(false);
      return;
    }
    fetch(`/api/fit-rec?product_ids=${encodeURIComponent(ids)}`, {
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setRecs((j?.recs as Record<string, FitRec>) ?? {});
      })
      .catch(() => {
        if (cancelled) return;
        setRecs({});
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [items]);

  if (loading) return null;
  if (!recs) return null;

  const withRec = items.filter((it) => {
    const r = recs[it.id];
    return r && r.tier > 0 && (r.size != null || r.rationale != null);
  });
  if (withRec.length === 0) return null;

  return (
    <div className="fitrec-panel">
      {withRec.map((it) => {
        const r = recs[it.id];
        const heading =
          items.length > 1
            ? `${it.brand ? it.brand + " " : ""}${it.name}`
            : null;
        return (
          <div key={it.id} className="fitrec-row">
            {heading ? <div className="fitrec-name">{heading}</div> : null}
            {r.size ? (
              <div className="fitrec-size">
                Your size in this: <strong>{r.size}</strong>
                <span className={`fitrec-conf fitrec-conf-${r.confidence}`}>
                  {r.confidence === "high"
                    ? "high confidence"
                    : r.confidence === "medium"
                      ? "medium confidence"
                      : "low confidence"}
                </span>
              </div>
            ) : r.model_line ? (
              <div className="fitrec-model">{r.model_line}</div>
            ) : null}
            {r.rationale && r.rationale !== r.model_line ? (
              <div className="fitrec-rationale">{r.rationale}</div>
            ) : null}
          </div>
        );
      })}

      <style jsx>{`
        .fitrec-panel {
          margin-top: 10px;
          padding: 12px 14px;
          background: #fafaf7;
          border: 1px solid #e6e0d4;
          border-radius: 14px;
          display: grid;
          gap: 10px;
        }
        .fitrec-row {
          display: grid;
          gap: 4px;
        }
        .fitrec-name {
          font-size: 12px;
          color: #6a6256;
          letter-spacing: 0.02em;
        }
        .fitrec-size {
          font-size: 15px;
          color: #18140e;
        }
        .fitrec-size strong {
          font-weight: 600;
        }
        .fitrec-conf {
          display: inline-block;
          margin-left: 8px;
          padding: 2px 8px;
          font-size: 10px;
          border-radius: 999px;
          background: #f1ede4;
          color: #6a6256;
          letter-spacing: 0.02em;
        }
        .fitrec-conf-high { background: #e5f0e5; color: #2a5a2a; }
        .fitrec-conf-medium { background: #f0ecd8; color: #6a5a1e; }
        .fitrec-conf-low { background: #f1ede4; color: #6a6256; }
        .fitrec-model {
          font-size: 14px;
          color: #3a342a;
          font-style: italic;
        }
        .fitrec-rationale {
          font-size: 13px;
          color: #4a4438;
          line-height: 1.45;
        }
      `}</style>
    </div>
  );
}
