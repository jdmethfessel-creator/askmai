"use client";

/**
 * Standalone sign-in modal. Same magic-link UX as the paywall modal
 * but framed as "Log in," not "you've used your free stylings." Used
 * from the nav on the homepage and on creator pages so a returning
 * subscriber has a persistent entry point — they shouldn't have to
 * trip the paywall first to sign back in.
 *
 * The modal works in two phases:
 *   "input" — collect email, POST /api/auth/send-link
 *   "sent"  — explain "check your email," with two follow-up CTAs:
 *               • "I'm signed in — reload" reloads the page so the
 *                 next server render reads signedIn=true.
 *               • "use a different email" loops back to "input."
 *
 * Cosmetics intentionally palette-agnostic — the modal renders the
 * surface/ink in neutral defaults so it works on the dark landing
 * page AND on a creator's themed page without looking out of place.
 */

import { useState } from "react";

type Phase = "input" | "sent";

export default function SignInModal({
  onClose,
  accent,
  title = "Log in",
  subtitle = "Enter your email — we'll send you a one-tap sign-in link.",
}: {
  onClose: () => void;
  accent?: string;
  title?: string;
  subtitle?: string;
}) {
  const [phase, setPhase] = useState<Phase>("input");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const buttonBg = accent ?? "#1a1610";
  const buttonInk = "#ffffff";

  const returnTo =
    typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/";

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@") || busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const r = await fetch("/api/auth/send-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, returnTo }),
      });
      if (r.status === 429) {
        const { error } = (await r.json().catch(() => ({}))) as {
          error?: string;
        };
        setErrorMsg(error ?? "Too many sign-in emails right now. Try again in a minute.");
      } else if (!r.ok) {
        setErrorMsg("Couldn't send the link. Try again?");
      } else {
        setPhase("sent");
      }
    } catch {
      setErrorMsg("Network blip. Try again?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center px-4 pb-4 pt-10 sm:p-6"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Log in"
    >
      <div
        className="w-full max-w-[420px] rounded-3xl px-6 py-7 relative"
        style={{
          background: "#fdfbf7",
          color: "#221d18",
          boxShadow:
            "0 24px 48px -12px rgba(0,0,0,0.32), 0 4px 16px rgba(0,0,0,0.12)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-3 right-3 h-8 w-8 rounded-full flex items-center justify-center text-[18px] opacity-50 hover:opacity-90"
        >
          ×
        </button>

        <h2
          className="text-[22px] leading-tight mb-1.5"
          style={{ fontFamily: "var(--font-display, Georgia), serif" }}
        >
          {title}
        </h2>
        <p className="text-[13.5px] opacity-70 leading-relaxed mb-5">
          {subtitle}
        </p>

        {phase === "input" ? (
          <form onSubmit={sendLink} className="space-y-3">
            <input
              type="email"
              required
              autoFocus
              inputMode="email"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              className="w-full rounded-2xl px-4 py-3 text-[14px] outline-none"
              style={{
                background: "rgba(0,0,0,0.04)",
                border: "1px solid rgba(0,0,0,0.08)",
              }}
            />
            <button
              type="submit"
              disabled={!email.includes("@") || busy}
              className="w-full rounded-2xl px-4 py-3 text-[14px] font-medium disabled:opacity-40 transition-opacity"
              style={{ background: buttonBg, color: buttonInk }}
            >
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
            {errorMsg && (
              <p className="text-[12px]" style={{ color: "#c53030" }}>
                {errorMsg}
              </p>
            )}
          </form>
        ) : (
          <div className="space-y-3">
            <p
              className="text-[16px]"
              style={{ fontFamily: "var(--font-display, Georgia), serif" }}
            >
              Check your email.
            </p>
            <p className="text-[13px] opacity-70 leading-relaxed">
              We sent a one-tap sign-in link to{" "}
              <span className="font-medium">{email}</span>. Click it,
              then tap below to continue.
            </p>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }}
              className="w-full rounded-2xl px-4 py-3 text-[14px] font-medium transition-opacity hover:opacity-95"
              style={{ background: buttonBg, color: buttonInk }}
            >
              I&apos;m signed in — continue
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("input");
                setErrorMsg(null);
              }}
              className="block w-full text-[12px] opacity-60 hover:opacity-90 underline underline-offset-2 transition-opacity"
            >
              use a different email
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
