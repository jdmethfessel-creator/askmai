"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, Rec } from "@/lib/types";
import { dedupeOutfitRecs, hasValidOutfitComposition } from "@/lib/outfitSlots";
import SignInModal from "@/app/_components/SignInModal";

const SUGGESTIONS = [
  "summer dinner outfit, easy but elevated",
  "skincare routine for travel",
  "hotel pick for a long weekend in italy",
  "spicy mezcal cocktail recommendation",
];

const RECS_MARKER = "---RECS---";

function splitResponse(raw: string): { text: string; recs?: Rec[] } {
  const idx = raw.indexOf(RECS_MARKER);
  if (idx === -1) return { text: raw };
  const text = raw.slice(0, idx).trimEnd();
  const jsonPart = raw.slice(idx + RECS_MARKER.length).trim();
  if (!jsonPart) return { text };
  const cleaned = jsonPart
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      const recs = parsed
        .filter((r): r is Rec => r && typeof r === "object" && "name" in r)
        .map((r) => ({
          name: String(r.name ?? ""),
          brand: r.brand ? String(r.brand) : undefined,
          category: String(r.category ?? ""),
          price: r.price ? String(r.price) : undefined,
          why: String(r.why ?? ""),
          image_url: r.image_url ? String(r.image_url) : undefined,
          location: r.location ? String(r.location) : undefined,
          affiliate_url:
            r.affiliate_url === null
              ? null
              : r.affiliate_url
              ? String(r.affiliate_url)
              : undefined,
          tier: r.tier as Rec["tier"],
          reservable:
            typeof r.reservable === "boolean" ? r.reservable : undefined,
          directions_url: r.directions_url
            ? String(r.directions_url)
            : undefined,
          menu_url: r.menu_url ? String(r.menu_url) : undefined,
        }));
      return { text, recs: recs.length > 0 ? recs : undefined };
    }
  } catch {
    // partial / invalid JSON — caller decides whether to fall back
  }
  return { text };
}

/**
 * Render-button category gate. Catalog-driven only, no title-keyword
 * matching: a card qualifies when its model-supplied `category` field
 * (lowercased + trimmed) is exactly "fashion" or "accessories". Beauty,
 * lifestyle, travel, dining, and null/other never get a render pill.
 *
 * Stays in sync with the server-side prompt's category enum so the
 * client and server agree on what's renderable.
 */
export function qualifiesForRender(rec: Rec): boolean {
  const cat = (rec.category ?? "").trim().toLowerCase();
  return cat === "fashion" || cat === "accessories";
}

type RenderQuota = {
  total: number;
  included: number;
  pack: number;
  ageVerified: boolean;
  hasPhoto: boolean;
};

type RenderState =
  | { phase: "closed" }
  | { phase: "loading"; kind: "single" | "outfit" }
  | { phase: "result"; url: string; kind: "single" | "outfit" }
  | { phase: "gate"; reason: "signin" | "age" | "photo" | "pack" }
  | { phase: "error"; message: string };

/**
 * Bundle of the props every card-level render pill needs. Plumbed
 * through EditorialBoard / LookSection / HeroProduct / FinisherCard /
 * RecCard so each card can fire the same `startSingle` / `startOutfit`
 * callback. The label flip ("Show This Item" vs "Buy Image Package")
 * is owned by the parent so all pills agree on which they show.
 */
type RenderHooks = {
  accent: string;
  quota: RenderQuota | null;
  busy: boolean;
  startSingle: (rec: Rec) => void;
  startOutfit: (recs: Rec[]) => void;
};

export default function Chat({
  slug,
  accent,
  creatorFirstName,
  signedIn,
  isSubscribed,
}: {
  slug: string;
  accent: string;
  creatorFirstName: string;
  signedIn: boolean;
  isSubscribed: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // Per-message kill-switch for the editorial-board renderer: when a hero
  // image fails to load on a visual-mode message, we flip its index in this
  // set and the next render demotes that message back to the card layout.
  // A failed hero image must NEVER stay on screen.
  const [demotedMessages, setDemotedMessages] = useState<Set<number>>(
    () => new Set()
  );
  const [paywallOpen, setPaywallOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ----- Render quota + modal state ---------------------------------
  // Quota is read once on mount when signed in. The label-flip rule
  // for the render pills ("Show This Item" vs "Buy Image Package")
  // keys off this. The actual gate is always re-checked server-side
  // in POST /api/render — this state only drives the UI.
  const [renderQuota, setRenderQuota] = useState<RenderQuota | null>(null);
  const [renderState, setRenderState] = useState<RenderState>({
    phase: "closed",
  });

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    fetch("/api/render/quota", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          d: {
            signed_in?: boolean;
            age_verified?: boolean;
            has_photo?: boolean;
            included_remaining?: number;
            pack_balance?: number;
            total_remaining?: number;
          } | null
        ) => {
          if (cancelled || !d || !d.signed_in) return;
          setRenderQuota({
            total: Number(d.total_remaining ?? 0),
            included: Number(d.included_remaining ?? 0),
            pack: Number(d.pack_balance ?? 0),
            ageVerified: Boolean(d.age_verified),
            hasPhoto: Boolean(d.has_photo),
          });
        }
      )
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const renderBusy =
    renderState.phase === "loading" || renderState.phase === "gate" || renderState.phase === "result";

  const runRender = useCallback(
    async (kind: "single" | "outfit", recs: Rec[]) => {
      // Filter to qualifying items with a usable reference image URL.
      // No image_url means we have nothing to send as a garment
      // reference, so silently drop.
      const items = recs
        .filter(qualifiesForRender)
        .filter((r) => typeof r.image_url === "string" && r.image_url.length > 0)
        .map((r) => ({
          image_url: r.image_url as string,
          name: r.name,
          brand: r.brand,
        }));
      if (items.length === 0) {
        setRenderState({ phase: "error", message: "Nothing to render here." });
        return;
      }
      // Signed-out short-circuit: open sign-in before spending a
      // second. The server would 401 anyway; doing it client-side
      // avoids a wasted round trip.
      if (!signedIn) {
        setRenderState({ phase: "gate", reason: "signin" });
        return;
      }
      // Zero-quota short-circuit: route straight to pack picker.
      if (renderQuota && renderQuota.total <= 0) {
        setRenderState({ phase: "gate", reason: "pack" });
        return;
      }
      setRenderState({ phase: "loading", kind });
      try {
        const r = await fetch("/api/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            creatorSlug: slug,
            items: kind === "single" ? items.slice(0, 1) : items,
          }),
        });
        if (r.status === 401) {
          setRenderState({ phase: "gate", reason: "signin" });
          return;
        }
        if (r.status === 403) {
          setRenderState({ phase: "gate", reason: "age" });
          return;
        }
        if (r.status === 412) {
          setRenderState({ phase: "gate", reason: "photo" });
          return;
        }
        if (r.status === 402) {
          // Server-side quota race (someone else's tab consumed the
          // last credit between mount and click). Same path as the
          // pre-empted zero-quota case: open the pack picker.
          const data = (await r.json().catch(() => null)) as {
            included_remaining?: number;
            pack_balance?: number;
          } | null;
          if (data) {
            setRenderQuota((prev) =>
              prev
                ? {
                    ...prev,
                    included: Number(data.included_remaining ?? 0),
                    pack: Number(data.pack_balance ?? 0),
                    total:
                      Number(data.included_remaining ?? 0) +
                      Number(data.pack_balance ?? 0),
                  }
                : prev
            );
          }
          setRenderState({ phase: "gate", reason: "pack" });
          return;
        }
        const data = (await r.json().catch(() => null)) as {
          ok?: boolean;
          signed_url?: string;
          included_remaining?: number;
          pack_balance?: number;
        } | null;
        if (!r.ok || !data?.ok || !data.signed_url) {
          setRenderState({
            phase: "error",
            message:
              "Render failed. Try again in a sec? Your credits aren't touched on failures.",
          });
          return;
        }
        if (typeof data.included_remaining === "number") {
          setRenderQuota((prev) =>
            prev
              ? {
                  ...prev,
                  included: data.included_remaining as number,
                  pack: Number(data.pack_balance ?? prev.pack),
                  total:
                    (data.included_remaining as number) +
                    Number(data.pack_balance ?? prev.pack),
                }
              : prev
          );
        }
        setRenderState({
          phase: "result",
          url: data.signed_url,
          kind,
        });
      } catch {
        setRenderState({
          phase: "error",
          message: "Network blip. Try again?",
        });
      }
    },
    [signedIn, renderQuota, slug]
  );

  const startSingle = useCallback(
    (rec: Rec) => {
      if (renderBusy) return;
      runRender("single", [rec]);
    },
    [runRender, renderBusy]
  );
  const startOutfit = useCallback(
    (recs: Rec[]) => {
      if (renderBusy) return;
      runRender("outfit", recs);
    },
    [runRender, renderBusy]
  );

  const renderHooks: RenderHooks = {
    accent,
    quota: renderQuota,
    busy: renderBusy,
    startSingle,
    startOutfit,
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function send(text: string) {
    const clean = text.trim();
    if (!clean || streaming) return;

    const baseHistory = messages;
    const next: ChatMessage[] = [
      ...baseHistory,
      { role: "user", content: clean },
      { role: "assistant", content: "" },
    ];
    setMessages(next);
    setInput("");
    setStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          message: clean,
          history: baseHistory,
        }),
      });

      // Free-tier cap: server returns 402 {paywalled:true,…}. Drop the
      // placeholder assistant bubble (keep the user's question), open
      // the modal, and skip the streaming path.
      if (res.status === 402) {
        let parsed: { paywalled?: boolean } | null = null;
        try {
          parsed = await res.json();
        } catch {
          parsed = null;
        }
        if (parsed?.paywalled) {
          setMessages((prev) => prev.slice(0, -1));
          setPaywallOpen(true);
          return;
        }
      }

      if (!res.ok || !res.body) {
        throw new Error(`Chat failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
        const visible = (() => {
          const idx = acc.indexOf(RECS_MARKER);
          return idx === -1 ? acc : acc.slice(0, idx).trimEnd();
        })();
        setMessages((prev) => {
          const copy = prev.slice();
          copy[copy.length - 1] = {
            role: "assistant",
            content: visible,
          };
          return copy;
        });
      }

      const { text, recs } = splitResponse(acc);
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: text || acc,
          recs,
        };
        return copy;
      });
    } catch (e) {
      const errMsg =
        e instanceof Error ? e.message : "Something went wrong.";
      setMessages((prev) => {
        const copy = prev.slice();
        copy[copy.length - 1] = {
          role: "assistant",
          content: `(${errMsg})`,
        };
        return copy;
      });
    } finally {
      setStreaming(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  return (
    <div
      className="flex flex-col w-full"
      style={{ minHeight: "min(560px, 70dvh)" }}
    >
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 sm:px-5 pt-5 pb-4"
        style={{ maxHeight: "min(64dvh, 620px)" }}
      >
        {messages.length === 0 ? (
          <div>
            <div
              className="mr-auto max-w-[88%] rounded-3xl rounded-bl-lg px-4 py-3 text-[13.5px] leading-relaxed mb-5"
              style={{ background: "rgba(0,0,0,0.035)" }}
            >
              hey! i&apos;m {creatorFirstName}&apos;s AI — ask me about my
              closet, routine, travel, or any of my favorite finds.
            </div>
            <p className="font-serif text-[13px] italic opacity-55 mb-2 pl-1">
              try asking
            </p>
            <div className="space-y-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  className="block w-full text-left text-[13px] rounded-2xl px-4 py-3 transition-all hover:translate-x-0.5"
                  style={{
                    background: "rgba(0,0,0,0.025)",
                    border: "1px solid rgba(0,0,0,0.05)",
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ul className="space-y-4">
            {messages.map((m, i) => {
              const isAssistant = m.role === "assistant";
              const isLast = i === messages.length - 1;
              const showCaret =
                isAssistant && streaming && isLast && !m.recs;
              const partitioned = m.recs ? partitionRecs(m.recs) : null;
              const visualEligible = !!(
                partitioned &&
                !demotedMessages.has(i) &&
                isVisualEligible(partitioned.products)
              );
              return (
                <li key={i} className="space-y-3">
                  {m.content && (
                    <div
                      className={`max-w-[88%] rounded-3xl px-4 py-3 text-[13.5px] leading-relaxed ${
                        m.role === "user"
                          ? "ml-auto text-white rounded-br-lg"
                          : "mr-auto rounded-bl-lg"
                      }`}
                      style={
                        m.role === "user"
                          ? {
                              background: accent,
                              boxShadow:
                                "0 1px 2px rgba(0,0,0,0.06)",
                            }
                          : {
                              background: "rgba(0,0,0,0.035)",
                            }
                      }
                    >
                      <span
                        className={
                          showCaret
                            ? "caret whitespace-pre-wrap"
                            : "whitespace-pre-wrap"
                        }
                      >
                        {visualEligible
                          ? extractLeadCaption(m.content)
                          : m.content}
                      </span>
                    </div>
                  )}

                  {partitioned && m.recs && m.recs.length > 0 && (
                    <div className="space-y-3 mr-auto max-w-[92%]">
                      {visualEligible ? (
                        <EditorialBoard
                          products={partitioned.products}
                          accent={accent}
                          onHeroFail={() =>
                            setDemotedMessages((prev) => {
                              if (prev.has(i)) return prev;
                              const next = new Set(prev);
                              next.add(i);
                              return next;
                            })
                          }
                          onRefine={send}
                          streaming={streaming}
                          renderHooks={renderHooks}
                        />
                      ) : (
                        partitioned.products.map((rec, j) => (
                          <RecCard
                            key={recKey(rec, j)}
                            rec={rec}
                            accent={accent}
                            renderHooks={renderHooks}
                          />
                        ))
                      )}
                      {partitioned.places.map((rec, j) => (
                        <RecCard
                          key={recKey(rec, partitioned.products.length + j)}
                          rec={rec}
                          accent={accent}
                          renderHooks={renderHooks}
                        />
                      ))}
                      <OutfitRenderPill
                        recs={partitioned.products}
                        hooks={renderHooks}
                        streaming={streaming && isLast}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        onSubmit={onSubmit}
        className="px-3 pb-3 pt-2"
        style={{
          background: "var(--surface)",
          borderTop: "1px solid rgba(0,0,0,0.05)",
        }}
      >
        <div
          className="flex items-center gap-2 rounded-full px-2 py-1.5"
          style={{
            background: "rgba(0,0,0,0.035)",
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="ask anything…"
            inputMode="text"
            className="flex-1 bg-transparent px-3 py-2 text-[14px] outline-none"
            disabled={streaming}
          />
          <button
            type="submit"
            disabled={!input.trim() || streaming}
            className="rounded-full px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40 transition-opacity"
            style={{ background: accent }}
          >
            {streaming ? "…" : "send"}
          </button>
        </div>
      </form>

      {paywallOpen && (
        <PaywallModal
          accent={accent}
          signedIn={signedIn}
          creatorFirstName={creatorFirstName}
          onClose={() => setPaywallOpen(false)}
        />
      )}

      {renderState.phase !== "closed" && (
        <RenderModal
          state={renderState}
          accent={accent}
          onClose={() => setRenderState({ phase: "closed" })}
        />
      )}
    </div>
  );
}

function PaywallModal({
  accent,
  signedIn,
  creatorFirstName,
  onClose,
}: {
  accent: string;
  signedIn: boolean;
  creatorFirstName: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [emailPhase, setEmailPhase] = useState<"input" | "sent">("input");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  // Exit-intent winback flow. When the user tries to dismiss the
  // paywall (X click, backdrop click, ESC), if they haven't been
  // offered the winback discount yet on this device, we intercept and
  // show a discount modal instead of closing. Once shown, the cookie
  // flag below ensures we never re-nag on subsequent paywall hits.
  // Dismissing the winback closes everything.
  const [showingWinback, setShowingWinback] = useState(false);
  const [winbackAvailable, setWinbackAvailable] = useState<boolean | null>(
    null
  );
  useEffect(() => {
    if (typeof document === "undefined") {
      setWinbackAvailable(false);
      return;
    }
    const seen = document.cookie
      .split(";")
      .some((c) => c.trim().startsWith("askmai_winback_offered=1"));
    setWinbackAvailable(!seen);
  }, []);

  const returnTo =
    typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/";

  // ?ref=CODE survives off the landing URL into this paywall modal too —
  // a visitor who hit a creator page through a referral link and then
  // gets paywalled still gets their inviter credited on signup. Strict
  // 7-char Crockford alphabet so a random param can't pollute the
  // magic-link redirect; invalid silently becomes undefined.
  const ref = (() => {
    if (typeof window === "undefined") return undefined;
    const raw = new URLSearchParams(window.location.search).get("ref");
    if (!raw) return undefined;
    const code = raw.trim().toUpperCase();
    return /^[2-9A-HJKM-NP-TV-Z]{7}$/.test(code) ? code : undefined;
  })();

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@") || busy) return;
    setBusy(true);
    setEmailError(null);
    try {
      const r = await fetch("/api/auth/send-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, returnTo, ref }),
      });
      if (!r.ok) {
        setEmailError("couldn't send the link. try again?");
      } else {
        setEmailPhase("sent");
      }
    } catch {
      setEmailError("network blip. try again?");
    } finally {
      setBusy(false);
    }
  }

  // Intercept dismiss intents. First dismiss (when winback available
  // AND user has already signed in) diverts to the winback modal;
  // second dismiss (or any dismiss when winback already shown / not
  // available / user not signed in) closes the paywall for real.
  // Cookie is set when the winback is FIRST shown so even a hard
  // reload won't re-offer.
  //
  // The signed-in gate matters: most paywall hits start anonymous,
  // and the meaningful "cold feet" moment is AFTER sign-in when the
  // user is staring at the plan picker. Offering the discount to an
  // anonymous visitor who's never even given an email wastes the
  // one-shot offer on people who weren't going to convert anyway.
  function handleDismiss() {
    if (signedIn && winbackAvailable && !showingWinback) {
      if (typeof document !== "undefined") {
        document.cookie =
          "askmai_winback_offered=1; Path=/; Max-Age=" +
          60 * 60 * 24 * 365 +
          "; SameSite=Lax";
      }
      setShowingWinback(true);
      setWinbackAvailable(false);
      return;
    }
    onClose();
  }
  function handleWinbackDismiss() {
    setShowingWinback(false);
    onClose();
  }
  // ESC key dismisses the paywall (and routes through handleDismiss so
  // it triggers winback intercept on first ESC). Re-registers when
  // dismiss-related state changes so the closure stays current.
  useEffect(() => {
    if (typeof document === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (showingWinback) handleWinbackDismiss();
        else handleDismiss();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // handleDismiss/handleWinbackDismiss are defined inline above and
    // read state directly, so re-registering on state change keeps
    // the listener pointing at the latest closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showingWinback, winbackAvailable]);

  async function startCheckout(
    plan: "monthly" | "annual",
    coupon?: "winback"
  ) {
    if (busy) return;
    setBusy(true);
    setPlanError(null);
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, returnTo, coupon }),
      });
      if (r.status === 401) {
        // Session expired between modal open and click — drop back to
        // sign-in.
        setPlanError("Please sign in first.");
        setBusy(false);
        return;
      }
      const data = (await r.json()) as { url?: string; error?: string };
      if (!r.ok || !data.url) {
        setPlanError("couldn't start checkout. try again?");
        setBusy(false);
        return;
      }
      window.location.href = data.url;
    } catch {
      setPlanError("network blip. try again?");
      setBusy(false);
    }
  }

  if (showingWinback) {
    return (
      <WinbackModal
        accent={accent}
        busy={busy}
        planError={planError}
        onAccept={() => startCheckout("monthly", "winback")}
        onDismiss={handleWinbackDismiss}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 pt-10 sm:p-6"
      style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)" }}
      onClick={handleDismiss}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-[420px] rounded-3xl px-6 py-7 relative"
        style={{
          background: "var(--surface)",
          color: "var(--ink)",
          boxShadow:
            "0 24px 48px -12px rgba(0,0,0,0.32), 0 4px 16px rgba(0,0,0,0.12)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Close"
          className="absolute top-3 right-3 h-8 w-8 rounded-full flex items-center justify-center text-[18px] opacity-50 hover:opacity-90"
        >
          ×
        </button>

        <h2 className="font-serif text-[22px] leading-tight mb-1.5">
          You&apos;ve used your free stylings.
        </h2>
        <p className="text-[13.5px] opacity-70 leading-relaxed mb-5">
          Subscribe to keep chatting with {creatorFirstName} and every other
          AskMai twin.
        </p>

        {signedIn ? (
          <div className="space-y-2.5">
            <button
              type="button"
              onClick={() => startCheckout("monthly")}
              disabled={busy}
              className="w-full rounded-2xl px-4 py-3.5 text-left transition-all hover:translate-y-[-1px] disabled:opacity-50"
              style={{
                background: accent,
                color: "#fff",
                boxShadow: "0 4px 12px -4px rgba(0,0,0,0.2)",
              }}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-serif text-[16px]">Monthly</span>
                <span className="font-serif text-[18px]">$9.99/mo</span>
              </div>
              <p className="text-[11.5px] opacity-85 mt-0.5">
                cancel anytime
              </p>
            </button>
            <button
              type="button"
              onClick={() => startCheckout("annual")}
              disabled={busy}
              className="w-full rounded-2xl px-4 py-3.5 text-left transition-all hover:translate-y-[-1px] disabled:opacity-50"
              style={{
                background: "rgba(0,0,0,0.04)",
                border: `1px solid ${accent}55`,
              }}
            >
              <div className="flex items-baseline justify-between">
                <span className="font-serif text-[16px]">Annual</span>
                <span
                  className="font-serif text-[18px]"
                  style={{ color: accent }}
                >
                  $29.99/yr
                </span>
              </div>
              <p className="text-[11.5px] opacity-65 mt-0.5">
                Best value · Save $90/yr
              </p>
            </button>
            {planError && (
              <p className="text-[12px] mt-2" style={{ color: "#c53030" }}>
                {planError}
              </p>
            )}
          </div>
        ) : emailPhase === "input" ? (
          <form onSubmit={sendLink} className="space-y-3">
            <p className="text-[13px] opacity-65 leading-relaxed">
              Sign in first — we&apos;ll email you a one-tap link.
            </p>
            <input
              type="email"
              required
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
              className="w-full rounded-2xl px-4 py-3 text-[14px] font-medium text-white disabled:opacity-40 transition-opacity"
              style={{ background: accent }}
            >
              {busy ? "Sending…" : "Send sign-in link"}
            </button>
            {emailError && (
              <p className="text-[12px]" style={{ color: "#c53030" }}>
                {emailError}
              </p>
            )}
          </form>
        ) : (
          // emailPhase === "sent" — the previous build dead-ended
          // here with no actionable button. Now: an explicit reload
          // CTA the user hits after clicking the link in their email
          // (re-checks the session on the server) plus a quiet
          // back-link in case they typed the address wrong.
          <div className="space-y-3">
            <p className="font-serif text-[16px]">Check your email.</p>
            <p className="text-[13px] opacity-70 leading-relaxed">
              We sent a one-tap sign-in link to{" "}
              <span className="font-medium">{email}</span>. Click it,
              then tap below to pick a plan.
            </p>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }}
              className="w-full rounded-2xl px-4 py-3 text-[14px] font-medium text-white transition-opacity hover:opacity-95"
              style={{ background: accent }}
            >
              I&apos;m signed in — show plans
            </button>
            <button
              type="button"
              onClick={() => {
                setEmailPhase("input");
                setEmailError(null);
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

function recKey(rec: Rec, fallback: number) {
  return `${rec.tier ?? "?"}-${rec.product_id ?? ""}-${rec.name ?? ""}-${fallback}`;
}

/**
 * Exit-intent winback modal — the second "page" of the paywall flow.
 * Shown ONCE per device (cookie-gated) when a SIGNED-IN user tries to
 * dismiss the paywall without subscribing. Anonymous dismisses skip
 * winback entirely — that one-shot offer is too valuable to burn on
 * visitors who haven't even given us an email.
 *
 * Premium tone: no urgency words, no countdowns, no aggressive
 * styling — just one quiet line on what's being offered.
 *
 * The Accept button funnels the user through the SAME /api/checkout
 * route as the regular Monthly button, but with coupon="winback" in
 * the body. That resolves server-side to STRIPE_WINBACK_COUPON_ID
 * (paywall_winback_50, 50% off for 3 months, repeating).
 */
function WinbackModal({
  accent,
  busy,
  planError,
  onAccept,
  onDismiss,
}: {
  accent: string;
  busy: boolean;
  planError: string | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 pt-10 sm:p-6"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)" }}
      onClick={onDismiss}
      role="dialog"
      aria-modal="true"
      aria-label="50% off offer"
    >
      <div
        className="w-full max-w-[400px] rounded-3xl px-7 py-8 relative"
        style={{
          background: "var(--surface)",
          color: "var(--ink)",
          boxShadow:
            "0 24px 48px -12px rgba(0,0,0,0.36), 0 4px 16px rgba(0,0,0,0.16)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close"
          className="absolute top-3 right-3 h-8 w-8 rounded-full flex items-center justify-center text-[18px] opacity-50 hover:opacity-90"
        >
          ×
        </button>

        {/* Eyebrow — small accent line above the headline. No "WAIT!"
            or "DON'T GO!" — just a quiet category-style label. */}
        <p
          className="text-[10.5px] mb-3.5"
          style={{
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: accent,
            opacity: 0.85,
          }}
        >
          One more thing
        </p>

        <h2
          className="font-serif text-[24px] leading-[1.15] mb-2.5"
          style={{ letterSpacing: "-0.01em" }}
        >
          Stay for a minute.
        </h2>
        <p className="text-[13.5px] opacity-75 leading-relaxed mb-6">
          50% off your first 3 months. Same access, half the price —
          that&apos;s it.
        </p>

        <button
          type="button"
          onClick={onAccept}
          disabled={busy}
          className="w-full rounded-2xl px-4 py-3.5 text-[14.5px] font-medium text-white disabled:opacity-50 transition-all hover:translate-y-[-1px]"
          style={{
            background: accent,
            boxShadow: "0 4px 12px -4px rgba(0,0,0,0.2)",
          }}
        >
          {busy ? "One moment…" : "Continue at 50% off →"}
        </button>

        <button
          type="button"
          onClick={onDismiss}
          className="block w-full mt-3 text-[12.5px] opacity-55 hover:opacity-85 transition-opacity"
        >
          Not today
        </button>

        {planError && (
          <p
            className="text-[12px] mt-3 text-center"
            style={{ color: "#c53030" }}
          >
            {planError}
          </p>
        )}
      </div>
    </div>
  );
}

// -------- Editorial-board (visual-first) renderer --------

function partitionRecs(recs: Rec[]): { products: Rec[]; places: Rec[] } {
  const products: Rec[] = [];
  const places: Rec[] = [];
  for (const r of recs) {
    if (
      r.tier === "place" ||
      r.tier === "hotel" ||
      r.category === "dining" ||
      r.category === "travel"
    ) {
      places.push(r);
    } else {
      products.push(r);
    }
  }
  return { products, places };
}

/**
 * Eligibility for the visual layout. The gate is IMAGE RELIABILITY, not
 * product tier. The board fires when the response has at least two
 * non-synth products with a confirmed image_url (server resolved it from
 * a real source: feed/owned_feed catalog, Serper, or Bing prefetch in
 * the chat route), AND the hero candidate has one.
 *
 * Synth recs (off-catalog scanner) are excluded — they're low-confidence
 * by design and would risk a wrong/placeholder image as the hero.
 *
 * Final runtime guard: `onHeroFail` demotes to cards if the hero image
 * actually fails to load. A wrong/placeholder image never stays on
 * screen.
 */
function isVisualEligible(products: Rec[]): boolean {
  if (products.length < 2) return false;
  if (countReliableImages(products) < 2) return false;
  return pickHeroCandidate(products) !== null;
}

function countReliableImages(products: Rec[]): number {
  let n = 0;
  for (const p of products) {
    if (p.synth) continue;
    if (!p.image_url) continue;
    n++;
  }
  return n;
}

function pickHeroCandidate(products: Rec[]): Rec | null {
  const eligible = products.filter((p) => !!p.image_url && !p.synth);
  if (eligible.length === 0) return null;
  // Prefer real catalog tiers (Shopify image, highest confidence).
  // Aggregator items only become the hero when no feed/owned candidate
  // exists.
  const feedFirst = eligible.filter(
    (p) => p.tier === "feed" || p.tier === "owned_feed"
  );
  const pool = feedFirst.length > 0 ? feedFirst : eligible;
  // Second-highest-priced piece — leading with the most expensive item
  // made boards feel unapproachable (it's usually the aspirational
  // outlier). Picking #2 keeps centerpiece-garment energy without the
  // price-sticker shock. Items with no parseable price drop out of the
  // ranking; if only one item has a price we return it (no "second"
  // exists), and if nothing is priced we fall back to pool[0] so the
  // visual board still fires.
  //
  // Known limitation: hero is chosen on PRICE alone, so an accessory
  // (e.g. sandals on a tiny beach-outfit board) can land as the hero
  // when its price happens to sit at second-highest. The proper fix is
  // category-aware preference — pick from {fashion, dress, top, bottom,
  // jacket} before {accessories} for outfit-type requests. Deferred.
  const priced = pool
    .map((p, origIndex) => ({ p, n: parsePriceNum(p.price), origIndex }))
    .filter(
      (x): x is { p: Rec; n: number; origIndex: number } => x.n !== null
    );
  if (priced.length === 0) return pool[0];
  if (priced.length === 1) return priced[0].p;
  // Descending by price; ties broken by original (model-emitted) order.
  priced.sort((a, b) => b.n - a.n || a.origIndex - b.origIndex);
  return priced[1].p;
}

function parsePriceNum(s: string | undefined): number | null {
  if (!s) return null;
  const m = String(s).match(/(\d{1,5}(?:,\d{3})*(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}


function outfitTotal(products: Rec[]): number | null {
  let total = 0;
  let count = 0;
  for (const p of products) {
    const n = parsePriceNum(p.price);
    if (n != null) {
      total += n;
      count++;
    }
  }
  return count >= 2 ? total : null;
}

function extractLeadCaption(prose: string): string {
  if (!prose) return prose;
  // Trim, drop trailing whitespace. Take the first 1-2 sentences (up to
  // ~180 chars) so the visual layout leads with voice, not a paragraph.
  const trimmed = prose.trim();
  if (trimmed.length <= 180) return trimmed;
  // Sentence-end match: . ! or ? followed by space or end.
  const reSentence = /[.!?](?:\s|$)/g;
  let end = -1;
  let cuts = 0;
  let m: RegExpExecArray | null;
  while ((m = reSentence.exec(trimmed)) !== null) {
    cuts++;
    end = m.index + 1;
    if (cuts >= 2 || end >= 180) break;
  }
  if (end > 0) return trimmed.slice(0, end).trim();
  return trimmed.slice(0, 180).trim() + "…";
}

type RefineChip = { label: string; prompt: string };

// Category-keyed refine chip sets. The board picks ONE set based on
// its dominant product category so a skincare board never offers
// "dressier" and an outfit board never offers "fragrance-free." Each
// set ends with two universal-feeling chips ("cheaper" + a "different
// X" axis) that work regardless of category.
const FASHION_CHIPS: RefineChip[] = [
  { label: "dressier", prompt: "make it dressier" },
  { label: "more casual", prompt: "make it more casual" },
  { label: "different color", prompt: "show me different colors" },
  { label: "cheaper", prompt: "show me a cheaper version of this outfit" },
];

const BEAUTY_CHIPS: RefineChip[] = [
  { label: "gentler", prompt: "show me gentler options" },
  {
    label: "fragrance-free",
    prompt: "show me fragrance-free alternatives",
  },
  { label: "cleaner ingredients", prompt: "show me cleaner-ingredient options" },
  { label: "cheaper", prompt: "show me a cheaper version" },
];

const LIFESTYLE_CHIPS: RefineChip[] = [
  { label: "more minimal", prompt: "show me a more minimal version" },
  { label: "different style", prompt: "try a different style" },
  { label: "cheaper", prompt: "show me a cheaper version" },
];

// Used for mixed boards or when the board's category can't be told
// from its products. Stays neutral on purpose.
const UNIVERSAL_CHIPS: RefineChip[] = [
  { label: "cheaper", prompt: "show me a cheaper version" },
  { label: "different vibe", prompt: "try a different vibe" },
];

type CategoryBucket = "fashion" | "beauty" | "lifestyle" | "mixed";

function categoryBucketOf(c: string | undefined | null): CategoryBucket | null {
  const v = (c ?? "").toLowerCase();
  // Bags / shoes / jewelry / belts / hats all live under "accessories"
  // in our enum but belong with fashion chips ("dressier" still makes
  // sense for a heel; "fragrance-free" doesn't).
  if (v === "fashion" || v === "accessories") return "fashion";
  if (v === "beauty") return "beauty";
  if (v === "lifestyle" || v === "travel") return "lifestyle";
  return null;
}

function dominantBucket(products: Rec[]): CategoryBucket {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const p of products) {
    const bucket = categoryBucketOf(p.category);
    if (!bucket || bucket === "mixed") continue;
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    total++;
  }
  if (total === 0) return "mixed";
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topBucket, topCount] = entries[0];
  // Dominant when ≥60% of categorizable items agree. Below that the
  // board's a mix (e.g. an outfit + a skincare pick) and the only
  // chips that don't read as a non-sequitur are the universal ones.
  if (topCount / total < 0.6) return "mixed";
  return topBucket as CategoryBucket;
}

function chipsForBoard(products: Rec[]): RefineChip[] {
  switch (dominantBucket(products)) {
    case "fashion":
      return FASHION_CHIPS;
    case "beauty":
      return BEAUTY_CHIPS;
    case "lifestyle":
      return LIFESTYLE_CHIPS;
    default:
      return UNIVERSAL_CHIPS;
  }
}

/**
 * Chunk an ordered product list into per-look groups. ≤5 products =>
 * single look. Larger lists get split into roughly-4-item groups
 * (Math.ceil(N/4) groups, evenly distributed) which approximates a
 * weekend packing list of "outfit 1, outfit 2, outfit 3" or a fall
 * wardrobe pull. The model already emits recs in its own intended
 * order (dress, shoes, bag, jewelry…) and the server-side ranker
 * preserves that within tier, so a naive in-order chunk lines up
 * reasonably well with the model's per-outfit groupings without
 * requiring it to emit explicit group labels.
 */
function chunkIntoLooks(products: Rec[]): Rec[][] {
  if (products.length <= 5) return [products];
  const groupCount = Math.ceil(products.length / 4);
  const perGroup = Math.ceil(products.length / groupCount);
  const groups: Rec[][] = [];
  for (let i = 0; i < products.length; i += perGroup) {
    groups.push(products.slice(i, i + perGroup));
  }
  return groups;
}

function EditorialBoard({
  products,
  accent,
  onHeroFail,
  onRefine,
  streaming,
  renderHooks,
}: {
  products: Rec[];
  accent: string;
  onHeroFail: () => void;
  onRefine: (prompt: string) => void;
  streaming: boolean;
  renderHooks: RenderHooks;
}) {
  // Quick gate: if we can't even pick a hero for the whole set we
  // demote the whole message rather than render partials.
  if (!pickHeroCandidate(products)) {
    onHeroFail();
    return null;
  }
  const looks = chunkIntoLooks(products);
  const total = outfitTotal(products);
  return (
    <div className="space-y-5">
      {looks.map((look, idx) => (
        <LookSection
          key={`look-${idx}-${look[0]?.name ?? ""}`}
          products={look}
          accent={accent}
          onHeroFail={onHeroFail}
          renderHooks={renderHooks}
        />
      ))}
      {total != null && (
        <p
          className="text-[11px] uppercase tracking-[0.2em] opacity-65 font-medium pt-0.5"
          style={{ color: "var(--ink)" }}
        >
          ${total.toLocaleString()} total · {products.length} pieces
        </p>
      )}
      {!streaming && (
        <div className="flex flex-wrap gap-1.5 pt-1.5">
          {chipsForBoard(products).map((chip) => (
            <button
              key={chip.label}
              type="button"
              onClick={() => onRefine(chip.prompt)}
              className="text-[11px] px-3 py-1.5 rounded-full transition-all hover:translate-y-[-1px]"
              style={{
                border: `1px solid ${accent}55`,
                color: accent,
                background: "rgba(0,0,0,0.02)",
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One outfit's worth of board: a single hero product + the rest of
 * the group as photo-only finishers in a 2-col grid. Letter-tile
 * placeholders are dropped (server-side prefetch already exhausted
 * the Bing fallback, so a missing image_url here is permanent).
 */
function LookSection({
  products,
  accent,
  onHeroFail,
  renderHooks,
}: {
  products: Rec[];
  accent: string;
  onHeroFail: () => void;
  renderHooks: RenderHooks;
}) {
  const hero = pickHeroCandidate(products);
  if (!hero) return null;
  const finishers = products.filter(
    (p) => p !== hero && Boolean(p.image_url) && !p.synth
  );
  return (
    <div className="space-y-3">
      <HeroProduct
        rec={hero}
        accent={accent}
        onFail={onHeroFail}
        renderHooks={renderHooks}
      />
      {finishers.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5">
          {finishers.map((rec, i) => (
            <FinisherCard
              key={`fin-${i}-${rec.name}`}
              rec={rec}
              accent={accent}
              renderHooks={renderHooks}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HeroProduct({
  rec,
  accent,
  onFail,
  renderHooks,
}: {
  rec: Rec;
  accent: string;
  onFail: () => void;
  renderHooks: RenderHooks;
}) {
  if (!rec.image_url) {
    // Should never happen given eligibility, but if image_url disappears
    // mid-flight, demote the whole response rather than render a hero gap.
    onFail();
    return null;
  }
  const proxied = `/api/img?url=${encodeURIComponent(rec.image_url)}`;
  return (
    <article
      className="relative w-full overflow-hidden rounded-2xl"
      style={{
        aspectRatio: "1 / 1.1",
        background: `${accent}11`,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={proxied}
        alt=""
        loading="lazy"
        className="absolute inset-0 w-full h-full object-cover"
        onError={onFail}
      />
      <div
        className="absolute inset-x-0 bottom-0 p-3.5 flex items-end justify-between gap-3"
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.3) 45%, rgba(0,0,0,0) 80%)",
        }}
      >
        <div className="text-white min-w-0 flex-1">
          {rec.brand && (
            <p className="text-[10px] uppercase tracking-[0.18em] opacity-90 mb-0.5 font-medium truncate">
              {rec.brand}
            </p>
          )}
          <h3 className="font-serif text-[17px] leading-tight">{rec.name}</h3>
          {rec.price && (
            <p className="text-[14px] font-medium mt-1 opacity-95">
              {rec.price}
            </p>
          )}
          <SingleRenderPill
            rec={rec}
            hooks={renderHooks}
            variant="overlay"
          />
        </div>
        {rec.affiliate_url && (
          <a
            href={rec.affiliate_url}
            target="_blank"
            rel="noopener sponsored"
            className={`text-[12px] px-3.5 py-2 rounded-full font-semibold whitespace-nowrap shrink-0 transition-transform hover:translate-y-[-1px]${
              rec.tier === "feed" ? " noskim" : ""
            }`}
            style={{ background: "#ffffff", color: "#111" }}
          >
            Shop →
          </a>
        )}
      </div>
    </article>
  );
}

function FinisherCard({
  rec,
  accent,
  renderHooks,
}: {
  rec: Rec;
  accent: string;
  renderHooks: RenderHooks;
}) {
  const initial = (rec.brand?.trim()?.[0] ?? rec.name.trim()[0] ?? "?")
    .toUpperCase();
  return (
    <article
      className="rounded-xl overflow-hidden flex flex-col"
      style={{
        background: "rgba(0,0,0,0.025)",
        border: "1px solid rgba(0,0,0,0.05)",
      }}
    >
      <div className="relative w-full" style={{ aspectRatio: "1 / 1" }}>
        <FinisherImage rec={rec} accent={accent} initial={initial} />
      </div>
      <div className="p-2.5 space-y-0.5">
        {rec.brand && (
          <p className="text-[9px] uppercase tracking-[0.14em] opacity-60 truncate">
            {rec.brand}
          </p>
        )}
        <h4 className="font-serif text-[13px] leading-tight line-clamp-2">
          {rec.name}
        </h4>
        <div className="flex items-baseline justify-between gap-2 pt-1">
          <span className="text-[11px] font-medium opacity-90">
            {rec.price ?? ""}
          </span>
          {rec.affiliate_url && (
            <a
              href={rec.affiliate_url}
              target="_blank"
              rel="noopener sponsored"
              className={`text-[10px] font-semibold tracking-wide${
                rec.tier === "feed" ? " noskim" : ""
              }`}
              style={{ color: accent }}
            >
              Shop →
            </a>
          )}
        </div>
        <SingleRenderPill rec={rec} hooks={renderHooks} variant="compact" />
      </div>
    </article>
  );
}

/**
 * Square-fill image for finisher cards. Mirrors the lazy lookup behavior
 * of Thumb (for aggregator items without server-resolved image_url, fire
 * /api/product-image) but renders absolute-fill in the parent square.
 * Synth cards skip the lookup — tile only — and any image error in any
 * tier collapses to the tile so a broken image never lands in the grid.
 */
function FinisherImage({
  rec,
  accent,
  initial,
}: {
  rec: Rec;
  accent: string;
  initial: string;
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(
    rec.image_url
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setResolvedSrc(rec.image_url);
    setFailed(false);
  }, [rec.image_url]);

  useEffect(() => {
    if (resolvedSrc || !rec.name || rec.synth) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (rec.brand) params.set("brand", rec.brand);
    params.set("product", rec.name);
    fetch(`/api/product-image?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { imageUrl?: string | null } | null) => {
        if (cancelled) return;
        if (data?.imageUrl) setResolvedSrc(data.imageUrl);
      })
      .catch(() => {
        // stay on the tile
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedSrc, rec.brand, rec.name, rec.synth]);

  if (!resolvedSrc || failed) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center font-serif text-3xl text-white"
        style={{
          background: `linear-gradient(135deg, ${accent}, ${accent}aa)`,
        }}
        aria-hidden
      >
        {initial}
      </div>
    );
  }
  const proxied = `/api/img?url=${encodeURIComponent(resolvedSrc)}`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={proxied}
      alt=""
      loading="lazy"
      className="absolute inset-0 w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function RecCard({
  rec,
  accent,
  renderHooks,
}: {
  rec: Rec;
  accent: string;
  renderHooks: RenderHooks;
}) {
  const initial = (rec.brand?.trim()?.[0] ?? rec.name.trim()[0] ?? "?")
    .toUpperCase();
  return (
    <article
      className="rounded-2xl p-3 flex items-stretch gap-3"
      style={{
        background: "rgba(0,0,0,0.025)",
        border: "1px solid rgba(0,0,0,0.05)",
      }}
    >
      <Thumb
        src={rec.image_url}
        initial={initial}
        accent={accent}
        brand={rec.brand}
        name={rec.name}
        location={rec.location}
        isPlace={rec.tier === "place"}
        synth={rec.synth === true}
      />
      <div className="flex-1 min-w-0 flex flex-col justify-between gap-1.5">
        <div>
          {rec.brand && (
            <p className="text-[10px] uppercase tracking-[0.14em] opacity-60 mb-0.5">
              {rec.brand}
            </p>
          )}
          <h3 className="font-serif text-[15px] leading-tight">
            {rec.name}
          </h3>
          {rec.why && (
            <p className="text-xs leading-snug opacity-75 mt-1.5">
              {rec.why}
            </p>
          )}
        </div>
        <div className="flex items-baseline justify-between gap-2 mt-1">
          <span className="text-xs font-medium">
            {rec.price ?? rec.location ?? ""}
          </span>
          <PrimaryAction rec={rec} accent={accent} />
        </div>
        <SingleRenderPill rec={rec} hooks={renderHooks} />
        {rec.tier === "place" && (
          <PlaceSecondaryLinks rec={rec} accent={accent} />
        )}
      </div>
    </article>
  );
}

function PrimaryAction({ rec, accent }: { rec: Rec; accent: string }) {
  if (!rec.affiliate_url) return null;
  const label =
    rec.tier === "place"
      ? rec.reservable
        ? "Reserve →"
        : "Directions →"
      : rec.category === "travel"
      ? "Book →"
      : "Shop →";
  return (
    <a
      href={rec.affiliate_url}
      target="_blank"
      rel="noopener sponsored"
      // Feed-tier links are already affiliate-tagged (LinkSynergy / Rakuten);
      // tell the Skimlinks DOM script to skip them.
      className={`text-xs font-semibold tracking-wide${
        rec.tier === "feed" ? " noskim" : ""
      }`}
      style={{ color: accent }}
    >
      {label}
    </a>
  );
}

function PlaceSecondaryLinks({
  rec,
  accent,
}: {
  rec: Rec;
  accent: string;
}) {
  const links: { label: string; href: string }[] = [];
  if (rec.menu_url) links.push({ label: "Menu", href: rec.menu_url });
  // When Reserve is primary, also expose Directions; when Directions is
  // primary, the secondary row stays empty (Menu only, if relevant).
  if (rec.reservable && rec.directions_url) {
    links.push({ label: "Directions", href: rec.directions_url });
  }
  if (links.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-2 text-[11px] opacity-70">
      {links.map((l, i) => (
        <span key={l.label} className="inline-flex items-center gap-2">
          <a
            href={l.href}
            target="_blank"
            rel="noopener"
            className="underline-offset-2 hover:underline"
            style={{ color: accent }}
          >
            {l.label}
          </a>
          {i < links.length - 1 && <span aria-hidden>·</span>}
        </span>
      ))}
    </div>
  );
}

function Thumb({
  src,
  initial,
  accent,
  brand,
  name,
  location,
  isPlace,
  synth,
}: {
  src?: string;
  initial: string;
  accent: string;
  brand?: string;
  name?: string;
  location?: string;
  /** Place cards do a place-biased lookup (name + location + "restaurant"). */
  isPlace?: boolean;
  /** True for off-catalog scanner cards — skip Bing, render tile only. */
  synth?: boolean;
}) {
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(src);
  const [failed, setFailed] = useState(false);

  // Sync prop changes (e.g., feed-tier cards arriving with src already set).
  useEffect(() => {
    setResolvedSrc(src);
    setFailed(false);
  }, [src]);

  // Lazy lookup: off-feed product cards (no image_url) and place cards
  // (always lookup) both fire a Bing-backed search through /api/product-image.
  //
  // Synth cards (server-side off-catalog scanner) skip the lookup — a Bing
  // result on a partially-fabricated query is the source of "fire station for
  // cane-back accent chair" failures. Tile is the safer default for low-
  // confidence cards.
  useEffect(() => {
    if (resolvedSrc || !name) return;
    if (synth && !isPlace) return;
    let cancelled = false;
    const params = new URLSearchParams();
    if (isPlace) {
      const q = [name, location].filter(Boolean).join(" ");
      params.set("q", q);
      params.set("type", "place");
    } else {
      if (brand) params.set("brand", brand);
      if (name) params.set("product", name);
    }
    fetch(`/api/product-image?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { imageUrl?: string | null } | null) => {
        if (cancelled) return;
        if (data?.imageUrl) setResolvedSrc(data.imageUrl);
      })
      .catch(() => {
        // stay on the tile
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedSrc, isPlace, brand, name, location, synth]);

  const tile = (
    <div
      className="h-20 w-20 sm:h-24 sm:w-24 rounded-xl flex items-center justify-center font-serif text-2xl shrink-0 text-white"
      style={{
        background: `linear-gradient(135deg, ${accent}, ${accent}aa)`,
      }}
      aria-hidden
    >
      {initial}
    </div>
  );
  if (!resolvedSrc || failed) return tile;
  const proxied = `/api/img?url=${encodeURIComponent(resolvedSrc)}`;
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={proxied}
      alt=""
      onError={() => setFailed(true)}
      className="h-20 w-20 sm:h-24 sm:w-24 rounded-xl object-cover shrink-0 bg-black/5"
    />
  );
}

// -------------------- Render pills (Phase 2) ----------------------
//
// Two pill variants:
//
//   SingleRenderPill   - on every qualifying product card. Renders that
//                        one item onto the user's uploaded photo.
//
//   OutfitRenderPill   - one per assistant message that has >=2
//                        qualifying items. Renders all of them together
//                        as a single "look."
//
// Both share the same label-flip rule: when quota.total <= 0 the label
// becomes "Buy Image Package" and the click routes to pack checkout
// instead of /api/render.
//
// The pill style intentionally differs from the EditorialBoard refine
// chips: refine chips are tinted accent on a near-transparent ground;
// the render pills are solid accent fill, white text — they read as
// the primary action.

function SingleRenderPill({
  rec,
  hooks,
  variant,
}: {
  rec: Rec;
  hooks: RenderHooks;
  variant?: "overlay" | "compact";
}) {
  if (!qualifiesForRender(rec)) return null;
  if (!rec.image_url) return null;
  const outOfQuota = hooks.quota !== null && hooks.quota.total <= 0;
  const label = outOfQuota ? "Buy Image Package" : "Show This Item on Me";
  const onClick = () => {
    if (hooks.busy) return;
    hooks.startSingle(rec);
  };

  if (variant === "overlay") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={hooks.busy}
        className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-3 py-1.5 disabled:opacity-50 transition-all hover:translate-y-[-1px]"
        style={{
          background: "#ffffff",
          color: hooks.accent,
          boxShadow: "0 2px 6px -2px rgba(0,0,0,0.3)",
        }}
      >
        {label}
      </button>
    );
  }

  const compact = variant === "compact";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={hooks.busy}
      className={`${compact ? "mt-1.5 text-[10.5px] px-2.5 py-1" : "mt-1.5 text-[11px] px-3 py-1.5"} inline-flex items-center justify-center rounded-full font-semibold text-white disabled:opacity-50 transition-all hover:translate-y-[-1px]`}
      style={{
        background: hooks.accent,
        boxShadow: "0 2px 6px -3px rgba(0,0,0,0.35)",
      }}
    >
      {label}
    </button>
  );
}

function OutfitRenderPill({
  recs,
  hooks,
  streaming,
}: {
  recs: Rec[];
  hooks: RenderHooks;
  streaming: boolean;
}) {
  // Per-response gate: only mount when at least two qualifying items
  // exist so a 1-item response never gets the outfit button. Single
  // items keep just their per-card pill.
  //
  // Slot dedup runs CLIENT-side as well as server-side. The render
  // endpoint should never receive two heels (or two bags, two
  // dresses) because that's not a coherent outfit — gpt-image-1
  // would try to interpret the duplicate and the result is
  // unpredictable. dedupeOutfitRecs is the same lib the chat assembler
  // uses, so server + client agree on what a "complete look" is.
  const qualifying = dedupeOutfitRecs(
    recs.filter(
      (r) => qualifiesForRender(r) && typeof r.image_url === "string" && r.image_url.length > 0
    )
  );
  if (qualifying.length < 2) return null;
  // Composition gate: a coherent outfit needs a top-level garment
  // (a dress, OR top + bottom). A pile of accessories (sunglasses +
  // jewelry + bag) is not an outfit, so we hide the "Try This Outfit
  // on Me" pill. Each accessory still has its per-card render pill,
  // which is the right granularity for those items.
  if (!hasValidOutfitComposition(qualifying)) return null;
  // Suppress while the message is mid-stream — the outfit pill would
  // appear before the final card render and look like a flicker.
  if (streaming) return null;
  const outOfQuota = hooks.quota !== null && hooks.quota.total <= 0;
  const label = outOfQuota ? "Buy Image Package" : "Try This Outfit on Me";
  return (
    <button
      type="button"
      onClick={() => {
        if (hooks.busy) return;
        hooks.startOutfit(qualifying);
      }}
      disabled={hooks.busy}
      className="mt-1 w-full rounded-2xl px-4 py-3 text-[13px] font-semibold text-white disabled:opacity-50 transition-all hover:translate-y-[-1px]"
      style={{
        background: hooks.accent,
        boxShadow: "0 4px 12px -4px rgba(0,0,0,0.25)",
      }}
    >
      {label}
    </button>
  );
}

// -------------------- Render result + gate modal ------------------
//
// One modal, several phases:
//
//   loading -> spinner while gpt-image-1 is running
//   result  -> finished render with Save / Share / Try another
//   gate    -> "sign in" | "verify age" | "upload photo" | "buy pack"
//   error   -> generic try-again
//
// Gate routing:
//   signin  -> reuses SignInModal
//   age     -> link to /profile
//   photo   -> link to /profile
//   pack    -> pack picker (20 or 50). On click, POST /api/checkout
//              with { pack } and redirect to the Stripe URL.

function RenderModal({
  state,
  accent,
  onClose,
}: {
  state: RenderState;
  accent: string;
  onClose: () => void;
}) {
  if (state.phase === "gate" && state.reason === "signin") {
    return (
      <SignInModal
        accent={accent}
        title="Sign in to try this on"
        subtitle="Enter your email and we'll send a one-tap sign-in link. After signing in you can upload your photo and start rendering."
        onClose={onClose}
      />
    );
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-end sm:items-center justify-center px-4 pb-4 pt-10 sm:p-6"
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Try-on render"
    >
      <div
        className="w-full max-w-[460px] rounded-3xl px-6 py-7 relative"
        style={{
          background: "var(--surface)",
          color: "var(--ink)",
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
        <RenderModalBody state={state} accent={accent} onClose={onClose} />
      </div>
    </div>
  );
}

function RenderModalBody({
  state,
  accent,
  onClose,
}: {
  state: RenderState;
  accent: string;
  onClose: () => void;
}) {
  if (state.phase === "loading") {
    return <LoadingPanel accent={accent} />;
  }

  if (state.phase === "result") {
    return <ResultPanel url={state.url} kind={state.kind} accent={accent} onClose={onClose} />;
  }

  if (state.phase === "gate") {
    if (state.reason === "age" || state.reason === "photo") {
      const headline =
        state.reason === "age"
          ? "Quick age check first."
          : "Add a try-on photo first.";
      const sub =
        state.reason === "age"
          ? "Renders are 18+. Verify your age on your profile and you can try things on."
          : "Upload a full-body photo on your profile so we have something to dress.";
      return (
        <div className="space-y-4">
          <h2 className="font-serif text-[20px] leading-tight">{headline}</h2>
          <p className="text-[13px] opacity-70 leading-relaxed">{sub}</p>
          <a
            href="/profile"
            className="block w-full rounded-2xl px-4 py-3 text-[14px] font-medium text-white text-center transition-opacity hover:opacity-95"
            style={{ background: accent }}
          >
            Go to profile
          </a>
          <button
            type="button"
            onClick={onClose}
            className="block w-full text-[12px] opacity-60 hover:opacity-90 transition-opacity"
          >
            Not now
          </button>
        </div>
      );
    }
    // pack
    return <PackPicker accent={accent} onClose={onClose} />;
  }

  if (state.phase === "error") {
    return (
      <div className="space-y-3">
        <h2 className="font-serif text-[20px] leading-tight">Something went sideways.</h2>
        <p className="text-[13px] opacity-70 leading-relaxed">{state.message}</p>
        <button
          type="button"
          onClick={onClose}
          className="block w-full rounded-2xl px-4 py-3 text-[14px] font-medium text-white transition-opacity hover:opacity-95"
          style={{ background: accent }}
        >
          Close
        </button>
      </div>
    );
  }

  return null;
}

/**
 * LoadingPanel — replaces the static "Rendering…" copy with a
 * rotating set of fashion/styling-flavored anticipation lines and an
 * editorial shimmer bar that holds visual interest across the full
 * ~60s render.
 *
 * Design choices considered:
 *   - Three-dot outfit-assembly motif: too "loader," not editorial.
 *   - Soft expanding ring: generic spinner energy, off-brand.
 *   - Editorial shimmer bar (this one): a thin accent-colored sweep
 *     across a hairline ground. Reads like luxury page-load shimmer
 *     (Vogue / Net-a-Porter). Premium, quiet, doesn't distract from
 *     the rotating headline.
 *
 * Long-tail behavior: after 60s the rotation pool gains two extra
 * lines so the copy never feels stalled. The shimmer keeps running
 * at the same cadence so the rhythm stays consistent.
 *
 * Pure client side, no libs, no localStorage. Cleans up its own
 * interval + timeout on unmount.
 */
function LoadingPanel({ accent }: { accent: string }) {
  // Eight rotating lines. Fashion / styling flavor, present-tense,
  // no em dashes. Each is short enough to read in a glance (the
  // crossfade between lines runs every ~3.5s).
  const baseLines = [
    "Steaming the silk",
    "Finding your angles",
    "Pulling the look together",
    "Checking the fit",
    "Choosing the right shoe",
    "Pinning the hem",
    "Adjusting the drape",
    "One last look in the mirror",
  ];
  // Long-tail additions: only enter the rotation after ~60s so the
  // wait never starts to feel stuck. Quieter, "we know it's taking
  // a beat" energy without saying so explicitly.
  const longTailLines = ["Worth the wait", "Almost there"];

  // Start at a random index so two renders in a row don't both open
  // with "Steaming the silk." Keeps repeat sessions feeling fresh.
  const [idx, setIdx] = useState(() => Math.floor(Math.random() * baseLines.length));
  const [longTail, setLongTail] = useState(false);

  useEffect(() => {
    const ROTATE_MS = 3500;
    const LONG_TAIL_AFTER_MS = 60_000;
    const rotate = setInterval(() => {
      setIdx((i) => i + 1);
    }, ROTATE_MS);
    const longTailTimer = setTimeout(() => setLongTail(true), LONG_TAIL_AFTER_MS);
    return () => {
      clearInterval(rotate);
      clearTimeout(longTailTimer);
    };
  }, []);

  const pool = longTail ? [...baseLines, ...longTailLines] : baseLines;
  const currentLine = pool[idx % pool.length];

  return (
    <div className="py-6 text-center space-y-5">
      {/* Headline crossfades on every rotation. The `key` change
          re-mounts the element so the fadeIn keyframe runs cleanly
          without React having to manage the transition state. */}
      <div className="min-h-[2.2em] flex items-center justify-center">
        <h2
          key={currentLine}
          className="font-serif text-[20px] leading-tight loading-fade"
          style={{ color: "var(--ink)" }}
        >
          {currentLine}
        </h2>
      </div>

      {/* Editorial shimmer bar. Hairline ground tinted from the
          creator's accent so it ties to the rest of the modal; a
          translucent gradient highlight sweeps across left to right
          on a 1.8s loop. The highlight uses the full accent at its
          centerline and fades to transparent at the edges so the
          sweep reads as light moving across silk. */}
      <div
        className="relative h-[2px] w-full overflow-hidden rounded-full mx-auto"
        style={{ background: `${accent}1f`, maxWidth: "240px" }}
        aria-hidden
      >
        <span
          className="loading-shimmer absolute top-0 bottom-0"
          style={{
            background: `linear-gradient(90deg, transparent 0%, ${accent} 50%, transparent 100%)`,
          }}
        />
      </div>

      {/* Single subtle reassurance line. Muted, small — not the
          headline. The rotating copy carries the experience; this
          is just a quiet footer for someone who looks twice. */}
      <p className="text-[11.5px] opacity-50 leading-relaxed">
        We only use a credit if it finishes.
      </p>

      <style>{`
        @keyframes loadingFadeIn {
          0% { opacity: 0; transform: translateY(4px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .loading-fade {
          animation: loadingFadeIn 0.55s ease-out both;
        }
        @keyframes loadingShimmerSweep {
          0% { left: -40%; }
          100% { left: 100%; }
        }
        .loading-shimmer {
          width: 40%;
          left: -40%;
          animation: loadingShimmerSweep 1.8s ease-in-out infinite;
        }
        @media (prefers-reduced-motion: reduce) {
          .loading-fade { animation: none; }
          .loading-shimmer { animation: none; left: 30%; }
        }
      `}</style>
    </div>
  );
}

function ResultPanel({
  url,
  kind,
  accent,
  onClose,
}: {
  url: string;
  kind: "single" | "outfit";
  accent: string;
  onClose: () => void;
}) {
  const [shareError, setShareError] = useState<string | null>(null);
  const headline =
    kind === "outfit" ? "Here's the look on you." : "Here it is on you.";
  async function onShare() {
    setShareError(null);
    if (typeof navigator === "undefined") return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "My AskMai try-on",
          text: "Rendered on askmai.co",
          url,
        });
        return;
      } catch {
        // user dismissed or share failed — fall through to copy
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareError("Link copied.");
    } catch {
      setShareError("Couldn't copy. Long-press the image to save.");
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="font-serif text-[20px] leading-tight">{headline}</h2>
      <div
        className="w-full overflow-hidden rounded-2xl"
        style={{ background: "rgba(0,0,0,0.04)" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt="Your try-on render"
          className="w-full h-auto block"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <a
          href={url}
          download="askmai-tryon.png"
          target="_blank"
          rel="noopener"
          className="block text-center rounded-2xl px-4 py-3 text-[13px] font-medium transition-opacity hover:opacity-95"
          style={{
            background: "rgba(0,0,0,0.06)",
            color: "var(--ink)",
          }}
        >
          Save
        </a>
        <button
          type="button"
          onClick={onShare}
          className="block rounded-2xl px-4 py-3 text-[13px] font-medium text-white transition-opacity hover:opacity-95"
          style={{ background: accent }}
        >
          Share
        </button>
      </div>
      {shareError && (
        <p className="text-[12px] opacity-70 text-center">{shareError}</p>
      )}
      <button
        type="button"
        onClick={onClose}
        className="block w-full text-[12px] opacity-60 hover:opacity-90 transition-opacity"
      >
        Done
      </button>
    </div>
  );
}

function PackPicker({
  accent,
  onClose,
}: {
  accent: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"pack_20" | "pack_50" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function buy(pack: "pack_20" | "pack_50") {
    if (busy) return;
    setBusy(pack);
    setError(null);
    const returnTo =
      typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : "/";
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack, returnTo }),
      });
      const data = (await r.json().catch(() => null)) as {
        url?: string;
        error?: string;
      } | null;
      if (!r.ok || !data?.url) {
        setError("Couldn't start checkout. Try again?");
        setBusy(null);
        return;
      }
      window.location.href = data.url;
    } catch {
      setError("Network blip. Try again?");
      setBusy(null);
    }
  }
  return (
    <div className="space-y-4">
      <h2 className="font-serif text-[20px] leading-tight">
        Out of renders for now.
      </h2>
      <p className="text-[13px] opacity-70 leading-relaxed">
        Your monthly 3 included renders are spent. Pick a pack to keep
        trying things on. Pack credits never expire.
      </p>
      <div className="space-y-2.5">
        <button
          type="button"
          onClick={() => buy("pack_20")}
          disabled={busy !== null}
          className="w-full rounded-2xl px-4 py-3.5 text-left transition-all hover:translate-y-[-1px] disabled:opacity-50"
          style={{
            background: "rgba(0,0,0,0.04)",
            border: `1px solid ${accent}55`,
          }}
        >
          <div className="flex items-baseline justify-between">
            <span className="font-serif text-[16px]">20 renders</span>
            <span className="font-serif text-[18px]">$9.99</span>
          </div>
          <p className="text-[11.5px] opacity-65 mt-0.5">never expires</p>
        </button>
        <button
          type="button"
          onClick={() => buy("pack_50")}
          disabled={busy !== null}
          className="w-full rounded-2xl px-4 py-3.5 text-left text-white transition-all hover:translate-y-[-1px] disabled:opacity-50"
          style={{
            background: accent,
            boxShadow: "0 4px 12px -4px rgba(0,0,0,0.2)",
          }}
        >
          <div className="flex items-baseline justify-between">
            <span className="font-serif text-[16px]">50 renders</span>
            <span className="font-serif text-[18px]">$20.99</span>
          </div>
          <p className="text-[11.5px] opacity-85 mt-0.5">best value</p>
        </button>
      </div>
      {error && (
        <p className="text-[12px]" style={{ color: "#c53030" }}>
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={onClose}
        className="block w-full text-[12px] opacity-60 hover:opacity-90 transition-opacity"
      >
        Not now
      </button>
    </div>
  );
}
