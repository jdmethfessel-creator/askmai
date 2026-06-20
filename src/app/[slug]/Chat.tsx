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
}: {
  slug: string;
  accent: string;
  creatorFirstName: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
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
                        {m.content}
                      </span>
                    </div>
                  )}

                  {m.recs && m.recs.length > 0 && (
                    <div className="space-y-2.5 mr-auto max-w-[92%]">
                      {m.recs.map((rec, j) => (
                        <RecCard key={j} rec={rec} accent={accent} />
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
    </div>
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
          {rec.affiliate_url ? (
            <a
              href={rec.affiliate_url}
              target="_blank"
              rel="noopener sponsored"
              // Feed-tier links are already affiliate-tagged (LinkSynergy /
              // Rakuten); tell the Skimlinks DOM script to skip them.
              className={`text-xs font-semibold tracking-wide${
                rec.tier === "feed" ? " noskim" : ""
              }`}
              style={{ color: accent }}
            >
              {rec.category === "travel" ? "Book →" : "Shop →"}
            </a>
          ) : (
            <span className="text-[11px] italic opacity-50">
              {rec.category === "dining" ? "no link" : ""}
            </span>
          )}
        </div>
      </div>
    </article>
  );
}

function Thumb({
  src,
  initial,
  accent,
}: {
  src?: string;
  initial: string;
  accent: string;
}) {
  const [failed, setFailed] = useState(false);
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
  if (!src || failed) return tile;
  const proxied = `/api/img?url=${encodeURIComponent(src)}`;
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
