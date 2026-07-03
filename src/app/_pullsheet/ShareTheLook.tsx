"use client";

/**
 * ShareTheLook - creates a Look record via POST /api/looks and hands
 * the resulting /look/<slug> URL to the OS share sheet (falls back
 * to copying the URL and a small toast).
 *
 * Silent no-op if the looks table isn't there yet (endpoint returns
 * 500; button shows "Share not available" tooltip once).
 */

import { useCallback, useState } from "react";

export type ShareTheLookItem = {
  id?: string;
  name: string;
  brand?: string | null;
  price?: number | null;
  price_display?: string | null;
  source_network?: string | null;
  image_url: string;
  affiliate_url: string;
};

export default function ShareTheLook({
  creatorSlug,
  title,
  items,
  className = "",
}: {
  creatorSlug: string;
  title?: string | null;
  items: ShareTheLookItem[];
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const share = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/looks", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          creatorSlug,
          title: title ?? null,
          items,
        }),
      });
      if (!res.ok) {
        setMsg("Sharing isn't available yet.");
        return;
      }
      const json = await res.json();
      const slug = String(json?.slug ?? "");
      const url = `${window.location.origin}/look/${encodeURIComponent(slug)}`;
      const shareData = {
        title: title ?? "AskMai pull sheet",
        text: title ?? "A look on AskMai",
        url,
      };
      if (
        typeof navigator !== "undefined" &&
        typeof navigator.share === "function"
      ) {
        try {
          await navigator.share(shareData);
          setMsg("Shared.");
          return;
        } catch {
          /* fall through to copy */
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        setMsg("Link copied.");
      } catch {
        setMsg(url);
      }
    } catch {
      setMsg("Sharing isn't available yet.");
    } finally {
      setBusy(false);
    }
  }, [busy, creatorSlug, items, title]);

  return (
    <div className={className}>
      <button
        type="button"
        className="ps-btn ps-btn-primary"
        onClick={share}
        disabled={busy || items.length === 0}
      >
        {busy ? "Sharing…" : "Share the look"}
      </button>
      {msg ? (
        <p
          style={{
            fontSize: 12,
            color: "var(--ink-soft)",
            marginTop: 6,
            textAlign: "center",
          }}
        >
          {msg}
        </p>
      ) : null}
    </div>
  );
}
