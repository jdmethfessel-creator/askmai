"use client";

/**
 * Shared chrome for try-on render flows. Used by both the Shop tab
 * (TryOnGrid) and the Room tab (DressingRoom) so blocked-state copy
 * and the Save/Share button cluster stay in sync across surfaces.
 *
 * Save and Share hand the follower the exact same server-generated
 * 1080x1920 share card: no client-side composition, no chooser.
 * Save downloads the PNG; Share hands the same PNG to the OS share
 * sheet (or falls back to a download when Web Share is unavailable).
 */

import { useCallback, useState } from "react";

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

async function fetchShareCardBlob(afterUrl: string): Promise<Blob> {
  const res = await fetch(afterUrl, { credentials: "omit" });
  if (!res.ok) {
    throw new Error(`share card fetch ${res.status}`);
  }
  return res.blob();
}

export function ResultActions({
  afterUrl,
  shareTitle,
  shopUrl,
  shopLabel,
}: {
  afterUrl: string;
  shareTitle: string;
  shopUrl: string | null;
  shopLabel: string | null;
}) {
  const [working, setWorking] = useState<"" | "save" | "share">("");

  const onSave = useCallback(async () => {
    if (working) return;
    setWorking("save");
    try {
      const blob = await fetchShareCardBlob(afterUrl);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "askmai-tryon.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (e) {
      console.warn("[tryon] share card save failed, falling back", e);
      const a = document.createElement("a");
      a.href = afterUrl;
      a.download = "askmai-tryon.png";
      a.click();
    } finally {
      setWorking("");
    }
  }, [afterUrl, working]);

  const onShare = useCallback(async () => {
    if (working) return;
    setWorking("share");
    try {
      const blob = await fetchShareCardBlob(afterUrl);
      const file = new File([blob], "askmai-tryon.png", { type: "image/png" });
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
        console.warn("[tryon] share failed", e);
      }
    } finally {
      setWorking("");
    }
  }, [afterUrl, shareTitle, working]);

  return (
    <div className="tryon-modal-actions">
      <button
        type="button"
        className="tryon-btn tryon-btn-secondary"
        onClick={onSave}
        disabled={working !== ""}
      >
        {working === "save" ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        className="tryon-btn tryon-btn-secondary"
        onClick={onShare}
        disabled={working !== ""}
      >
        {working === "share" ? "Sharing…" : "Share"}
      </button>
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
