"use client";

import { useEffect, useRef, useState } from "react";
import type { ChatMessage, Rec } from "@/lib/types";

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
                        />
                      ) : (
                        partitioned.products.map((rec, j) => (
                          <RecCard
                            key={recKey(rec, j)}
                            rec={rec}
                            accent={accent}
                          />
                        ))
                      )}
                      {partitioned.places.map((rec, j) => (
                        <RecCard
                          key={recKey(rec, partitioned.products.length + j)}
                          rec={rec}
                          accent={accent}
                        />
                      ))}
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

  const returnTo =
    typeof window !== "undefined"
      ? window.location.pathname + window.location.search
      : "/";

  async function sendLink(e: React.FormEvent) {
    e.preventDefault();
    if (!email.includes("@") || busy) return;
    setBusy(true);
    setEmailError(null);
    try {
      const r = await fetch("/api/auth/send-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, returnTo }),
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

  async function startCheckout(plan: "monthly" | "annual") {
    if (busy) return;
    setBusy(true);
    setPlanError(null);
    try {
      const r = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, returnTo }),
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center px-4 pb-4 pt-10 sm:p-6"
      style={{ background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)" }}
      onClick={onClose}
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
          onClick={onClose}
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
                two months free
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
  // Prefer real catalog tiers (Shopify image, highest confidence); within
  // the pool, prefer the highest-priced piece — usually the centerpiece
  // garment. Aggregator items only become the hero when no feed/owned
  // candidate exists.
  const feedFirst = eligible.filter(
    (p) => p.tier === "feed" || p.tier === "owned_feed"
  );
  const pool = feedFirst.length > 0 ? feedFirst : eligible;
  let best = pool[0];
  let bestPrice = parsePriceNum(best.price);
  for (const p of pool.slice(1)) {
    const n = parsePriceNum(p.price);
    if (n != null && (bestPrice == null || n > bestPrice)) {
      best = p;
      bestPrice = n;
    }
  }
  return best;
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

const REFINE_CHIPS: { label: string; prompt: string }[] = [
  { label: "dressier", prompt: "make it dressier" },
  { label: "cheaper", prompt: "show me a cheaper version of this outfit" },
  { label: "more color", prompt: "more color, less neutral" },
  { label: "different vibe", prompt: "try a different vibe" },
];

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
}: {
  products: Rec[];
  accent: string;
  onHeroFail: () => void;
  onRefine: (prompt: string) => void;
  streaming: boolean;
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
          {REFINE_CHIPS.map((chip) => (
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
}: {
  products: Rec[];
  accent: string;
  onHeroFail: () => void;
}) {
  const hero = pickHeroCandidate(products);
  if (!hero) return null;
  const finishers = products.filter(
    (p) => p !== hero && Boolean(p.image_url) && !p.synth
  );
  return (
    <div className="space-y-3">
      <HeroProduct rec={hero} accent={accent} onFail={onHeroFail} />
      {finishers.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5">
          {finishers.map((rec, i) => (
            <FinisherCard
              key={`fin-${i}-${rec.name}`}
              rec={rec}
              accent={accent}
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
}: {
  rec: Rec;
  accent: string;
  onFail: () => void;
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

function FinisherCard({ rec, accent }: { rec: Rec; accent: string }) {
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

function RecCard({ rec, accent }: { rec: Rec; accent: string }) {
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
