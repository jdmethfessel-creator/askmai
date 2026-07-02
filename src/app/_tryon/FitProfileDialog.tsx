"use client";

/**
 * FitProfileDialog - the "quick fit inputs" dialog opened at photo
 * upload or first render. Every field is optional except height,
 * which unlocks tier-1 recommendations; skipping height still lets
 * the user finish (recommendations degrade to reference-only).
 *
 * The dialog itself never renders anything back to the user beyond
 * their own inputs. See lib/fit.ts and api/profile/fit/route.ts for
 * the privacy rule that keeps height / weight / measurements from
 * ever leaking out of the caller's own /api/profile/fit reads.
 *
 * Copy tone: fit + proportion only, no body judgment. See the
 * `body_hint` line under weight, and the fit-preference chip labels
 * (fitted / true / relaxed) rather than any adjective on the body.
 */

import { useCallback, useEffect, useState } from "react";

export type FitProfileInitial = {
  height_cm: number | null;
  weight_kg: number | null;
  usual_top: string | null;
  usual_bottom: string | null;
  usual_dress: string | null;
  anchor_brand: string | null;
  preference: "fitted" | "true" | "relaxed" | null;
};

const EMPTY: FitProfileInitial = {
  height_cm: null,
  weight_kg: null,
  usual_top: null,
  usual_bottom: null,
  usual_dress: null,
  anchor_brand: null,
  preference: null,
};

function cmToDisplay(cm: number | null): string {
  if (cm == null) return "";
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inches = Math.round(totalIn - ft * 12);
  return `${ft}'${inches}`;
}

export default function FitProfileDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial?: FitProfileInitial | null;
  onClose: () => void;
  onSaved?: (nextHasHeight: boolean) => void;
}) {
  const start = initial ?? EMPTY;
  const [heightStr, setHeightStr] = useState(cmToDisplay(start.height_cm));
  const [weightStr, setWeightStr] = useState(
    start.weight_kg != null ? String(Math.round(start.weight_kg)) : ""
  );
  const [usualTop, setUsualTop] = useState(start.usual_top ?? "");
  const [usualBottom, setUsualBottom] = useState(start.usual_bottom ?? "");
  const [usualDress, setUsualDress] = useState(start.usual_dress ?? "");
  const [anchorBrand, setAnchorBrand] = useState(start.anchor_brand ?? "");
  const [preference, setPreference] = useState<
    "fitted" | "true" | "relaxed" | null
  >(start.preference);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Lock body scroll while the dialog is open.
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const save = useCallback(
    async (dismissPromptOnly: boolean) => {
      setError(null);
      setSaving(true);
      const payload = dismissPromptOnly
        ? { dismiss_prompt: true }
        : {
            height: heightStr.trim() || null,
            weight: weightStr.trim() || null,
            usual_top: usualTop.trim() || null,
            usual_bottom: usualBottom.trim() || null,
            usual_dress: usualDress.trim() || null,
            anchor_brand: anchorBrand.trim() || null,
            preference: preference,
            dismiss_prompt: true,
          };
      const res = await fetch("/api/profile/fit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSaving(false);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(
          json?.error === "invalid_field"
            ? "Double-check your height and weight. Everything else is optional."
            : "Couldn't save. Try again in a moment."
        );
        return;
      }
      const json = await res.json();
      const nextHasHeight = Boolean(json?.profile?.height_cm);
      onSaved?.(nextHasHeight);
      onClose();
    },
    [
      anchorBrand,
      heightStr,
      onClose,
      onSaved,
      preference,
      usualBottom,
      usualDress,
      usualTop,
      weightStr,
    ]
  );

  return (
    <div
      className="fp-scrim"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="fp-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="fp-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
        <h2 className="fp-title">Quick fit inputs</h2>
        <p className="fp-sub">
          Optional. We use these for size recommendations only. Nothing
          here is ever shown publicly, on a share card, or in a
          fitting room.
        </p>

        <label className="fp-label">
          Height <span className="fp-req">required for personalized recs</span>
          <input
            className="fp-input"
            placeholder="5'4 or 163cm"
            value={heightStr}
            onChange={(e) => setHeightStr(e.target.value)}
            inputMode="decimal"
            autoFocus
          />
        </label>

        <label className="fp-label">
          Weight <span className="fp-optional">optional, skippable</span>
          <input
            className="fp-input"
            placeholder="kg"
            value={weightStr}
            onChange={(e) => setWeightStr(e.target.value)}
            inputMode="decimal"
          />
        </label>

        <div className="fp-row">
          <label className="fp-label fp-label-third">
            Tops
            <input
              className="fp-input"
              placeholder="S"
              value={usualTop}
              onChange={(e) => setUsualTop(e.target.value)}
              maxLength={16}
            />
          </label>
          <label className="fp-label fp-label-third">
            Bottoms
            <input
              className="fp-input"
              placeholder="27"
              value={usualBottom}
              onChange={(e) => setUsualBottom(e.target.value)}
              maxLength={16}
            />
          </label>
          <label className="fp-label fp-label-third">
            Dresses
            <input
              className="fp-input"
              placeholder="4"
              value={usualDress}
              onChange={(e) => setUsualDress(e.target.value)}
              maxLength={16}
            />
          </label>
        </div>

        <label className="fp-label">
          Anchor brand <span className="fp-optional">e.g. Aritzia</span>
          <input
            className="fp-input"
            placeholder="Aritzia"
            value={anchorBrand}
            onChange={(e) => setAnchorBrand(e.target.value)}
            maxLength={60}
          />
        </label>

        <div className="fp-label">
          Fit preference
          <div className="fp-chips">
            {(["fitted", "true", "relaxed"] as const).map((p) => (
              <button
                key={p}
                type="button"
                className={`fp-chip ${preference === p ? "is-on" : ""}`}
                onClick={() => setPreference(preference === p ? null : p)}
                aria-pressed={preference === p}
              >
                {p === "true" ? "true to size" : p}
              </button>
            ))}
          </div>
        </div>

        {error ? <p className="fp-error">{error}</p> : null}

        <div className="fp-actions">
          <button
            type="button"
            className="fp-btn fp-btn-ghost"
            onClick={() => save(true)}
            disabled={saving}
          >
            Skip for now
          </button>
          <button
            type="button"
            className="fp-btn fp-btn-primary"
            onClick={() => save(false)}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <style jsx>{`
        .fp-scrim {
          position: fixed;
          inset: 0;
          background: rgba(24, 20, 14, 0.55);
          display: grid;
          place-items: end center;
          z-index: 45;
        }
        @media (min-width: 480px) {
          .fp-scrim { align-items: center; padding: 24px; }
        }
        .fp-modal {
          background: #ffffff;
          color: #18140e;
          border-top-left-radius: 24px;
          border-top-right-radius: 24px;
          padding: 22px 20px 24px;
          width: 100%;
          max-width: 440px;
          position: relative;
          max-height: 92vh;
          overflow-y: auto;
          font-family: var(--font-body, ui-sans-serif, system-ui, sans-serif);
        }
        @media (min-width: 480px) {
          .fp-modal { border-radius: 24px; }
        }
        .fp-close {
          position: absolute;
          top: 12px;
          right: 12px;
          background: none;
          border: none;
          font-size: 16px;
          color: #6a6256;
          cursor: pointer;
          padding: 6px;
        }
        .fp-title {
          font: 600 20px/1.15 var(--font-display, Georgia, serif);
          margin: 0 0 6px;
        }
        .fp-sub {
          color: #6a6256;
          font-size: 13px;
          margin: 0 0 18px;
          line-height: 1.5;
        }
        .fp-label {
          display: block;
          font-size: 13px;
          color: #3a342a;
          margin-bottom: 12px;
          font-weight: 500;
        }
        .fp-label-third { flex: 1 1 0; margin-bottom: 0; }
        .fp-req {
          color: #a26a5a;
          font-weight: 400;
          margin-left: 6px;
          font-size: 11px;
          letter-spacing: 0.02em;
        }
        .fp-optional {
          color: #a9a193;
          font-weight: 400;
          margin-left: 6px;
          font-size: 11px;
        }
        .fp-input {
          display: block;
          width: 100%;
          margin-top: 6px;
          border: 1px solid #e6e0d4;
          border-radius: 12px;
          padding: 10px 12px;
          font-size: 15px;
          font-family: inherit;
          color: #18140e;
          background: #fafaf7;
        }
        .fp-input:focus {
          outline: none;
          border-color: #18140e;
        }
        .fp-row {
          display: flex;
          gap: 8px;
          margin-bottom: 12px;
        }
        .fp-chips {
          display: flex;
          gap: 6px;
          margin-top: 6px;
          flex-wrap: wrap;
        }
        .fp-chip {
          border: 1px solid #e6e0d4;
          background: #ffffff;
          border-radius: 999px;
          padding: 8px 14px;
          font-size: 13px;
          cursor: pointer;
          font-family: inherit;
          color: #18140e;
          text-transform: capitalize;
        }
        .fp-chip.is-on {
          background: #18140e;
          color: #fafaf7;
          border-color: #18140e;
        }
        .fp-error {
          color: #b00020;
          font-size: 13px;
          margin: 4px 0 12px;
        }
        .fp-actions {
          display: flex;
          gap: 8px;
          justify-content: space-between;
          margin-top: 8px;
        }
        .fp-btn {
          border-radius: 999px;
          padding: 12px 18px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          font-family: inherit;
          border: 1px solid transparent;
          transition: background 100ms ease;
        }
        .fp-btn:disabled { opacity: 0.5; cursor: default; }
        .fp-btn-primary {
          background: #18140e;
          color: #fafaf7;
        }
        .fp-btn-primary:hover { background: #2a2318; }
        .fp-btn-ghost {
          background: transparent;
          border-color: #e6e0d4;
          color: #6a6256;
        }
      `}</style>
    </div>
  );
}
