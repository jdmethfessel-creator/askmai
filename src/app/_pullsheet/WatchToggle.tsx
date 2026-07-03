"use client";

/**
 * WatchToggle - the "watch price" affordance rendered on hang tags,
 * result modals, and the Dressing Room "My items" section. Logged-in
 * users watch in one tap; anonymous callers get an inline email
 * capture rendered on demand.
 *
 * Silently no-ops on server-side missing-table errors (endpoint
 * returns 500; UI stays in the current visual state and logs to
 * console).
 */

import { useCallback, useEffect, useRef, useState } from "react";

export default function WatchToggle({
  productId,
  signedIn,
  className = "",
}: {
  productId: string;
  signedIn: boolean;
  className?: string;
}) {
  const [watching, setWatching] = useState(false);
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const requestedRef = useRef(false);

  useEffect(() => {
    if (!signedIn || requestedRef.current) return;
    // Signed-in users can lazy-check their watch state via a local
    // hint (localStorage cache) so we don't flood the wire on every
    // grid render. Server-side truth lands only when they tap.
    try {
      const cached = window.localStorage.getItem(`askmai:watching:${productId}`);
      if (cached === "1") setWatching(true);
    } catch {
      /* silent */
    }
  }, [productId, signedIn]);

  const onTap = useCallback(async () => {
    if (busy) return;
    if (!signedIn && !watching) {
      setShowEmail(true);
      return;
    }
    setBusy(true);
    if (watching) {
      // Unwatch (signed-in only)
      try {
        await fetch(`/api/watch?productId=${encodeURIComponent(productId)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
      } catch {
        /* silent */
      }
      setWatching(false);
      try {
        window.localStorage.removeItem(`askmai:watching:${productId}`);
      } catch {
        /* silent */
      }
    } else {
      try {
        const res = await fetch(`/api/watch`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId }),
        });
        if (res.ok) {
          setWatching(true);
          try {
            window.localStorage.setItem(`askmai:watching:${productId}`, "1");
          } catch {
            /* silent */
          }
        }
      } catch {
        /* silent */
      }
    }
    setBusy(false);
  }, [busy, productId, signedIn, watching]);

  const onEmailSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email.trim() || busy) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/watch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId, email: email.trim() }),
        });
        if (res.ok) {
          setWatching(true);
          setShowEmail(false);
        }
      } catch {
        /* silent */
      }
      setBusy(false);
    },
    [busy, email, productId]
  );

  return (
    <div className={`ps-watch ${className}`}>
      <button
        type="button"
        className="ps-btn ps-btn-secondary ps-btn-icon"
        aria-pressed={watching}
        title={watching ? "Watching price" : "Watch price"}
        aria-label={watching ? "Watching price" : "Watch price"}
        onClick={onTap}
        disabled={busy}
      >
        {watching ? "◆" : "◇"}
      </button>
      {showEmail && !signedIn ? (
        <form className="ps-watch-form" onSubmit={onEmailSubmit}>
          <input
            type="email"
            required
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="ps-watch-email"
            aria-label="Email for price drop alert"
          />
          <button
            type="submit"
            className="ps-btn ps-btn-primary"
            disabled={busy}
          >
            {busy ? "…" : "Confirm"}
          </button>
        </form>
      ) : null}

      <style jsx>{`
        .ps-watch {
          display: inline-flex;
          gap: 6px;
          align-items: center;
        }
        .ps-watch-form {
          display: flex;
          gap: 6px;
          align-items: center;
        }
        .ps-watch-email {
          border: 1px solid var(--ink);
          background: #ffffff;
          padding: 6px 10px;
          font-family: var(--font-body);
          font-size: 12px;
          color: var(--ink);
          outline: 0;
        }
      `}</style>
    </div>
  );
}
