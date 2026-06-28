"use client";

/**
 * Plays a one-shot wipe-line transition from beforeUrl to afterUrl
 * inside the result modal. The wipe is CSS clip-path so there's no
 * per-frame JS, no canvas, no recorder cost. After the wipe
 * completes the after layer alone remains visible (the before
 * element is removed from layout so subsequent renders don't
 * accumulate it).
 *
 * Falls back gracefully when beforeUrl is missing (legacy uploads):
 * just shows the after as a fade-in, no wipe.
 *
 * Sequence (must match beforeAfter.ts's video):
 *   0.0-0.5s  hold on before
 *   0.5-2.0s  wipe
 *   2.0+      hold on after
 */

import { useEffect, useState } from "react";

const HOLD_BEFORE_MS = 500;
const WIPE_MS = 1500;
const TOTAL_MS = HOLD_BEFORE_MS + WIPE_MS;

export default function BeforeAfterReveal({
  beforeUrl,
  afterUrl,
  alt,
}: {
  beforeUrl: string | null;
  afterUrl: string;
  alt: string;
}) {
  const [phase, setPhase] = useState<"hold" | "wiping" | "done">(
    beforeUrl ? "hold" : "done"
  );

  useEffect(() => {
    if (!beforeUrl) return;
    const t1 = setTimeout(() => setPhase("wiping"), HOLD_BEFORE_MS);
    const t2 = setTimeout(() => setPhase("done"), TOTAL_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [beforeUrl]);

  if (!beforeUrl || phase === "done") {
    return (
      <div className="tryon-reveal tryon-reveal-done">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="tryon-modal-image tryon-modal-image-reveal"
          src={afterUrl}
          alt={alt}
        />
      </div>
    );
  }

  // Compose two layered images. The before sits ON TOP and uses a
  // clip-path that shrinks left-to-right during the "wiping" phase,
  // revealing the after underneath. The thin highlight line on the
  // boundary is a sibling absolute div.
  return (
    <div className="tryon-reveal" aria-label={alt}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="tryon-modal-image tryon-reveal-after" src={afterUrl} alt="" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className={`tryon-modal-image tryon-reveal-before ${phase === "wiping" ? "is-wiping" : ""}`}
        src={beforeUrl}
        alt=""
      />
      <div
        className={`tryon-reveal-line ${phase === "wiping" ? "is-wiping" : ""}`}
        aria-hidden
      />
    </div>
  );
}
