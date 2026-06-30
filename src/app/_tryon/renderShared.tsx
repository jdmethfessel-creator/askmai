"use client";

/**
 * Shared chrome for try-on render flows. Used by both the Shop tab
 * (TryOnGrid) and the Room tab (DressingRoom) so blocked-state
 * copy + save/share/shop button cluster stay in sync across both
 * surfaces.
 *
 * Two pieces:
 *   - REASON_COPY / BlockReason: the canonical user-facing copy
 *     for each render-route error. 401 is intentionally NOT here
 *     (we open SignInModal in place; 401 is a routing event, not
 *     a try-on outcome).
 *   - ResultActions: Save (side-by-side PNG) + Share (animated
 *     reveal video, when MediaRecorder is supported) + optional
 *     Shop button. Pure client-side via canvas + MediaRecorder
 *     (see beforeAfter.ts). Falls back gracefully when before-image
 *     or MediaRecorder is unavailable.
 */

import { useCallback, useState } from "react";
import {
  composeRevealVideo,
  composeSideBySide,
  recorderMimeAvailable,
} from "./beforeAfter";

export type BlockReason =
  | "age_not_verified"
  | "no_photo"
  | "no_quota"
  | "moderation_blocked"
  | "render_failed";

export const REASON_COPY: Record<
  BlockReason,
  { title: string; body: string; cta?: { label: string; href: string } }
> = {
  age_not_verified: {
    title: "Quick age check",
    body: "Confirm your age once in your profile, then we can render.",
    cta: { label: "Open profile", href: "/profile" },
  },
  no_photo: {
    title: "Upload your try-on photo",
    body: "Add a full-body photo in your profile, then come back and tap Try This On.",
    cta: { label: "Open profile", href: "/profile" },
  },
  no_quota: {
    title: "Out of renders",
    body: "You've used your monthly renders. Grab a pack to keep going.",
    cta: { label: "Get more", href: "/profile" },
  },
  moderation_blocked: {
    title: "Safety filter caught this one",
    body: "The render provider's safety filter flagged this combination. It's probabilistic, so a retry often passes; or try a different piece or a different photo.",
  },
  render_failed: {
    title: "Something went sideways",
    body: "The render didn't come through. Try again in a moment.",
  },
};

export function ResultActions({
  beforeUrl,
  afterUrl,
  shareTitle,
  shopUrl,
  shopLabel,
}: {
  beforeUrl: string | null;
  afterUrl: string;
  shareTitle: string;
  shopUrl: string | null;
  shopLabel: string | null;
}) {
  const [working, setWorking] = useState<"" | "save" | "share">("");
  const canRecord =
    typeof window !== "undefined" && recorderMimeAvailable();

  const onSave = useCallback(async () => {
    if (!beforeUrl || working) return;
    setWorking("save");
    try {
      const blob = await composeSideBySide(beforeUrl, afterUrl);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "askmai-tryon.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      console.warn("[tryon] side-by-side save failed", e);
      const a = document.createElement("a");
      a.href = afterUrl;
      a.download = "askmai-tryon.png";
      a.click();
    } finally {
      setWorking("");
    }
  }, [beforeUrl, afterUrl, working]);

  const onShare = useCallback(async () => {
    if (!beforeUrl || working) return;
    setWorking("share");
    try {
      const blob = await composeRevealVideo(beforeUrl, afterUrl);
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      const file = new File([blob], `askmai-tryon.${ext}`, {
        type: blob.type,
      });
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function" &&
        typeof navigator.canShare === "function" &&
        navigator.canShare({ files: [file] })
      ) {
        await navigator.share({
          files: [file],
          title: shareTitle,
          text: shareTitle,
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5_000);
      }
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name !== "AbortError") {
        console.warn("[tryon] share failed, retrying as download", e);
      }
    } finally {
      setWorking("");
    }
  }, [beforeUrl, afterUrl, shareTitle, working]);

  return (
    <div className="tryon-modal-actions">
      {beforeUrl ? (
        <button
          type="button"
          className="tryon-btn tryon-btn-secondary"
          onClick={onSave}
          disabled={working !== ""}
        >
          {working === "save" ? "Saving…" : "Save image"}
        </button>
      ) : (
        <a
          className="tryon-btn tryon-btn-secondary"
          href={afterUrl}
          download="askmai-tryon.png"
        >
          Save image
        </a>
      )}
      {beforeUrl && canRecord ? (
        <button
          type="button"
          className="tryon-btn tryon-btn-secondary"
          onClick={onShare}
          disabled={working !== ""}
        >
          {working === "share" ? "Recording…" : "Share"}
        </button>
      ) : null}
      {shopUrl && shopLabel ? (
        <button
          type="button"
          className="tryon-btn tryon-btn-primary"
          onClick={() =>
            window.open(shopUrl, "_blank", "noopener,noreferrer")
          }
        >
          {shopLabel}
        </button>
      ) : null}
    </div>
  );
}
