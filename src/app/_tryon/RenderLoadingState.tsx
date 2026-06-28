"use client";

/**
 * Try-on loading state, replacing the prior spinner + "~60s"
 * note. Three moving parts:
 *
 *  1. Rotating cheeky styling lines, ~4.5s per line. Shuffled per
 *     mount so two consecutive renders don't read identically.
 *     First line includes the garment name; remaining lines are
 *     ambient (no product reference).
 *
 *  2. Eased progress bar that approaches ~90% over the expected
 *     render time (~60s single, ~N*15s outfit) and holds there
 *     until the parent flips the loaded prop. On load the bar
 *     races to 100% with a short transition. Never stalls at
 *     100% while still waiting.
 *
 *  3. Product thumbnail (or thumbnails for outfit mode) so the
 *     user looks at the garment they're trying on, not empty
 *     space. Subtle pulse shimmer is in CSS.
 *
 * Component is pure presentation: parent owns the loading -> result
 * transition and just stops mounting this when `loaded` flips.
 * The fade reveal on the actual result image is handled in the
 * parent modal via a CSS opacity transition keyed on `loaded`.
 */

import { useEffect, useMemo, useState } from "react";

const STYLING_LINES = [
  "Steaming out the wrinkles…",
  "Checking the fit…",
  "Pulling this from the rack…",
  "Styling you now…",
  "Finding your angles…",
  "Almost ready for your close-up…",
  "Tweaking the proportions…",
  "Pressing the seams…",
  "Smoothing the silhouette…",
  "Catching the light…",
  "Last fitting moment…",
  "Getting you in the look…",
];

const ROTATE_MS = 4500;
const PROGRESS_TICK_MS = 250;

function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export default function RenderLoadingState({
  thumbnails,
  garmentLabel,
  expectedSeconds,
  loaded,
}: {
  /** One thumbnail for single, multiple for outfit. */
  thumbnails: { src: string; alt: string }[];
  /** Used in the first rotating line ("Pulling X from the rack…"). */
  garmentLabel: string;
  /** Asymptote target time; progress approaches 90% over this duration. */
  expectedSeconds: number;
  /** Parent flips this true on result. Bar races to 100%. */
  loaded: boolean;
}) {
  const lines = useMemo(() => {
    const shuffled = shuffle(STYLING_LINES);
    // First line gets the garment label so the user knows the
    // pipeline knows what they asked for. Subsequent lines are
    // ambient.
    const intro = `Pulling ${garmentLabel} from the rack…`;
    return [intro, ...shuffled.slice(0, 8)];
  }, [garmentLabel]);

  const [idx, setIdx] = useState(0);
  useEffect(() => {
    if (loaded) return;
    const t = setInterval(
      () => setIdx((i) => (i + 1) % lines.length),
      ROTATE_MS
    );
    return () => clearInterval(t);
  }, [lines.length, loaded]);

  // Progress: eased asymptotic approach to 90% during loading,
  // jumps to 100% on load. progress = 90 * (1 - exp(-t/tau)),
  // tau picked so progress hits 90% at expectedSeconds.
  // tau = expectedSeconds / (-ln(1 - 0.999)) ≈ expectedSeconds / 6.9
  // (the .999 is the asymptote-fraction cap; 0.9/0.9 = 1.0 would be
  // log infinity, so we say 99.9% of the 90% cap).
  const tau = Math.max(2, expectedSeconds / 6.9);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (loaded) return;
    const start = Date.now();
    const t = setInterval(() => {
      setElapsed((Date.now() - start) / 1000);
    }, PROGRESS_TICK_MS);
    return () => clearInterval(t);
  }, [loaded]);

  const progressPct = loaded
    ? 100
    : Math.min(90, 90 * (1 - Math.exp(-elapsed / tau)));

  return (
    <div className="tryon-load">
      <div className="tryon-load-thumbs">
        {thumbnails.map((t, i) => (
          <div key={i} className="tryon-load-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={t.src} alt={t.alt} loading="eager" decoding="async" />
          </div>
        ))}
      </div>
      <div className="tryon-load-text" aria-live="polite">
        {lines[idx]}
      </div>
      <div
        className="tryon-load-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progressPct)}
      >
        <div
          className={`tryon-load-bar-fill ${loaded ? "is-complete" : ""}`}
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <p className="tryon-load-sub">Stay on this tab.</p>
    </div>
  );
}
