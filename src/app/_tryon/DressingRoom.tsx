"use client";

/**
 * Dressing Room surface — the third tab on a creator page.
 *
 * Sections:
 *   1. Saved items ("My items"): the user's localStorage-backed
 *      collection (one + tap on a Shop card writes here). Tap a
 *      card to select it for try-on. Multi-select honors the same
 *      slot rules as the old in-grid outfit-builder (see
 *      _tryon/outfit.ts).
 *   2. Saved looks ("My looks"): rendered images previously
 *      created from this room. Each look shows the rendered image
 *      + a per-piece Shop strip + a remove button.
 *
 * Try-on flow:
 *   - One or more selected items + "Try on" -> POST /api/render.
 *   - Single tryable item selected: kind="single".
 *   - Two or more tryable items: kind="outfit".
 *   - Non-tryable items (bags/shoes/jewelry/swim) are still saved
 *     but can't be selected for try-on; the + on them in the
 *     selector is dimmed with a "shop only" hint.
 *   - On success the rendered look is added to "My looks" via
 *     addLook. The signed URL is stored directly (7-day TTL —
 *     see store comments).
 *
 * Persistence: localStorage via dressingRoomStore. No login.
 * Auth still required for /api/render itself (existing SignIn
 * modal flow opens in place on 401).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import SignInModal from "../_components/SignInModal";
import RenderLoadingState from "./RenderLoadingState";
import BeforeAfterReveal from "./BeforeAfterReveal";
import {
  addLook,
  loadDressingRoom,
  removeItem,
  removeLook,
  type DressingRoom,
  type SavedItem,
  type SavedLook,
} from "./dressingRoomStore";
import {
  isTryOnEligibleSubcategory,
  selectedInOrder,
  slotForSubcategory,
  toggleSlot,
  type OutfitSlot,
} from "./outfit";
import { REASON_COPY, ResultActions, type BlockReason } from "./renderShared";

type RoomItem = SavedItem & { id: string; subcategory: string | null };

type RenderState =
  | { state: "idle" }
  | { state: "loading"; items: SavedItem[] }
  | {
      state: "result";
      items: SavedItem[];
      signedUrl: string;
      beforeSignedUrl: string | null;
    }
  | { state: "blocked"; items: SavedItem[]; reason: BlockReason };

export default function DressingRoom({
  creatorSlug,
}: {
  creatorSlug: string;
}) {
  const [room, setRoom] = useState<DressingRoom>(() => ({
    version: 1,
    items: [],
    looks: [],
  }));
  // Slot-keyed selection for try-on. SavedItem augmented with a
  // RoomItem-shaped { id, subcategory } so the shared `toggleSlot`
  // helper can act on it without knowing the rest of the payload.
  const [selected, setSelected] = useState<Partial<Record<OutfitSlot, RoomItem>>>(
    {}
  );
  const [render, setRender] = useState<RenderState>({ state: "idle" });
  const [showSignIn, setShowSignIn] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage on mount + listen for cross-tab edits
  // (the Shop tab's + button writes through the same store).
  useEffect(() => {
    setRoom(loadDressingRoom(creatorSlug));
    setHydrated(true);
    if (typeof window === "undefined") return;
    function onStorage(e: StorageEvent) {
      if (!e.key || !e.key.startsWith("askmai:dressing-room:")) return;
      setRoom(loadDressingRoom(creatorSlug));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [creatorSlug]);

  const selectedItems = useMemo(() => selectedInOrder(selected), [selected]);

  const onRemoveItem = useCallback(
    (id: string) => {
      setRoom(removeItem(creatorSlug, id));
      // Drop any selection on that id so the try-on tray reflects
      // the removal.
      setSelected((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next) as OutfitSlot[]) {
          if (next[k]?.id === id) delete next[k];
        }
        return next;
      });
    },
    [creatorSlug]
  );

  const onToggleSelect = useCallback((item: SavedItem) => {
    const sub = item.subcategory;
    if (!isTryOnEligibleSubcategory(sub)) return; // non-tryable: no-op
    const slot = slotForSubcategory(sub);
    if (!slot) return;
    setSelected((prev) =>
      toggleSlot(prev, { ...item, subcategory: sub } as RoomItem)
    );
  }, []);

  const onClearSelection = useCallback(() => setSelected({}), []);

  const runRender = useCallback(async () => {
    const items = selectedItems;
    if (items.length === 0) return;
    setRender({ state: "loading", items });
    const kind: "single" | "outfit" = items.length === 1 ? "single" : "outfit";
    try {
      const res = await fetch("/api/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          creatorSlug,
          items: items.map((p) => ({
            image_url: p.imageUrl,
            name: p.name,
            brand: p.brand ?? undefined,
            category: p.subcategory ?? undefined,
          })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 200 && json.signed_url) {
        const beforeSignedUrl =
          typeof json.before_signed_url === "string"
            ? json.before_signed_url
            : null;
        setRender({
          state: "result",
          items,
          signedUrl: json.signed_url,
          beforeSignedUrl,
        });
        // Persist as a saved look. Stores the signed URL directly
        // (see store comments for the 7-day TTL trade-off).
        setRoom(
          addLook(creatorSlug, {
            creatorSlug,
            renderUrl: json.signed_url,
            beforeUrl: beforeSignedUrl,
            itemIds: items.map((i) => i.id),
            itemSnapshots: items.map((i) => ({
              id: i.id,
              name: i.name,
              brand: i.brand,
              imageUrl: i.imageUrl,
              affiliateUrl: i.affiliateUrl,
            })),
          })
        );
        return;
      }
      if (json.error === "not_signed_in") {
        setRender({ state: "idle" });
        setShowSignIn(true);
        return;
      }
      const reason: BlockReason =
        json.error === "age_not_verified" ||
        json.error === "no_photo" ||
        json.error === "no_quota" ||
        json.error === "moderation_blocked"
          ? (json.error as BlockReason)
          : "render_failed";
      setRender({ state: "blocked", items, reason });
    } catch {
      setRender({ state: "blocked", items, reason: "render_failed" });
    }
  }, [creatorSlug, selectedItems]);

  const onRemoveLook = useCallback(
    (lookId: string) => {
      setRoom(removeLook(creatorSlug, lookId));
    },
    [creatorSlug]
  );

  // SSR / pre-hydration guard: localStorage is client-only and the
  // server doesn't know what's in the room, so we render the
  // skeleton until the first useEffect runs to avoid hydration
  // flicker.
  if (!hydrated) {
    return (
      <div className="tryon-page tryon-room">
        <div className="tryon-room-empty">Loading your room…</div>
      </div>
    );
  }

  return (
    <div className="tryon-page tryon-room">
      <section className="tryon-room-section">
        <header className="tryon-room-section-head">
          <h2 className="tryon-room-section-title">My items</h2>
          <span className="tryon-room-section-count">
            {room.items.length}
          </span>
        </header>

        {room.items.length === 0 ? (
          <div className="tryon-room-empty">
            <p>Nothing saved yet.</p>
            <p className="tryon-room-empty-sub">
              Tap the <span className="tryon-room-empty-plus">+</span> on
              any item in Shop to save it here.
            </p>
          </div>
        ) : (
          <div className="tryon-room-items">
            {room.items.map((item) => {
              const eligible = isTryOnEligibleSubcategory(item.subcategory);
              const slot = slotForSubcategory(item.subcategory);
              const isSelected = Boolean(
                slot && selected[slot]?.id === item.id
              );
              // Slot-conflict gating mirrors the old in-grid rules.
              // A non-self item already in this slot, OR cross-slot
              // dress/separates conflicts, both dim the card.
              const isBlocked =
                eligible &&
                !isSelected &&
                Boolean(
                  (slot && selected[slot]) ||
                    (slot === "dress" &&
                      (selected.top || selected.bottom)) ||
                    ((slot === "top" || slot === "bottom") && selected.dress)
                );
              return (
                <RoomCard
                  key={item.id}
                  item={item}
                  eligible={eligible}
                  selected={isSelected}
                  blocked={isBlocked}
                  onToggleSelect={onToggleSelect}
                  onRemove={onRemoveItem}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="tryon-room-section">
        <header className="tryon-room-section-head">
          <h2 className="tryon-room-section-title">My looks</h2>
          <span className="tryon-room-section-count">
            {room.looks.length}
          </span>
        </header>

        {room.looks.length === 0 ? (
          <div className="tryon-room-empty tryon-room-empty-quiet">
            Looks you try on land here.
          </div>
        ) : (
          <div className="tryon-room-looks">
            {room.looks.map((look) => (
              <LookCard key={look.id} look={look} onRemove={onRemoveLook} />
            ))}
          </div>
        )}
      </section>

      {selectedItems.length > 0 ? (
        <div
          className="tryon-outfit-tray"
          role="region"
          aria-label="Try-on selection"
        >
          <div className="tryon-outfit-thumbs">
            {selectedItems.map((p) => (
              <button
                key={p.id}
                type="button"
                className="tryon-outfit-thumb"
                aria-label={`Remove ${p.name} from selection`}
                onClick={() => onToggleSelect(p)}
                title={`${p.brand ? p.brand + " " : ""}${p.name} (tap to remove)`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.imageUrl} alt="" loading="lazy" decoding="async" />
                <span className="tryon-outfit-thumb-x" aria-hidden>
                  ✕
                </span>
              </button>
            ))}
          </div>
          <div className="tryon-outfit-actions">
            <button
              type="button"
              className="tryon-btn tryon-btn-ghost"
              onClick={onClearSelection}
              disabled={render.state === "loading"}
            >
              Clear
            </button>
            <button
              type="button"
              className="tryon-btn tryon-btn-primary"
              onClick={runRender}
              disabled={render.state === "loading"}
            >
              {render.state === "loading"
                ? "Rendering…"
                : `Try on${selectedItems.length > 1 ? " outfit" : ""} (${selectedItems.length})`}
            </button>
          </div>
        </div>
      ) : null}

      {render.state !== "idle" ? (
        <RenderModal state={render} onClose={() => setRender({ state: "idle" })} />
      ) : null}

      {showSignIn ? (
        <SignInModal
          onClose={() => setShowSignIn(false)}
          title="Sign in to try it on"
          subtitle="One-tap email link. We'll bring you right back here."
        />
      ) : null}
    </div>
  );
}

function RoomCard({
  item,
  eligible,
  selected,
  blocked,
  onToggleSelect,
  onRemove,
}: {
  item: SavedItem;
  eligible: boolean;
  selected: boolean;
  blocked: boolean;
  onToggleSelect: (item: SavedItem) => void;
  onRemove: (id: string) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  if (imgFailed) return null;
  const onShop = useCallback(() => {
    window.open(item.affiliateUrl, "_blank", "noopener,noreferrer");
  }, [item.affiliateUrl]);
  return (
    <article
      className={`tryon-card ${selected ? "is-in-outfit" : ""}`}
    >
      <div className="tryon-card-image-wrap">
        <button
          type="button"
          className="tryon-card-feature tryon-room-card-remove"
          aria-label="Remove from Try On"
          title="Remove from Try On"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.id);
          }}
        >
          ✕
        </button>
        {eligible ? (
          <button
            type="button"
            className={`tryon-card-select ${selected ? "is-selected" : ""} ${blocked ? "is-blocked" : ""}`}
            aria-pressed={selected}
            aria-disabled={blocked}
            aria-label={
              blocked
                ? "This slot is already filled"
                : selected
                ? "Remove from selection"
                : "Add to selection"
            }
            disabled={blocked}
            onClick={(e) => {
              e.stopPropagation();
              if (blocked) return;
              onToggleSelect(item);
            }}
          >
            {selected ? "✓" : "+"}
          </button>
        ) : (
          <span
            className="tryon-card-select tryon-room-card-shoponly"
            aria-label="Shop only — not tryable"
            title="Shop only"
          >
            ◇
          </span>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="tryon-card-image"
          src={item.imageUrl}
          alt={item.name}
          loading="lazy"
          decoding="async"
          onError={() => setImgFailed(true)}
        />
      </div>
      <div className="tryon-card-meta">
        {item.brand ? (
          <div className="tryon-card-brand">{item.brand}</div>
        ) : null}
        <div className="tryon-card-title">{item.name}</div>
        {item.priceDisplay ? (
          <div className="tryon-card-price">{item.priceDisplay}</div>
        ) : null}
      </div>
      <div className="tryon-card-actions">
        <button
          type="button"
          className="tryon-btn tryon-btn-secondary"
          onClick={onShop}
        >
          Shop
        </button>
      </div>
    </article>
  );
}

function LookCard({
  look,
  onRemove,
}: {
  look: SavedLook;
  onRemove: (id: string) => void;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const titleList = look.itemSnapshots
    .map((s) => `${s.brand ? s.brand + " " : ""}${s.name}`)
    .join(" · ");
  return (
    <article className="tryon-room-look">
      <div className="tryon-room-look-image-wrap">
        <button
          type="button"
          className="tryon-card-feature tryon-room-card-remove"
          aria-label="Remove this look"
          title="Remove this look"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(look.id);
          }}
        >
          ✕
        </button>
        {imgFailed ? (
          <div className="tryon-room-look-expired">
            <p>This look expired.</p>
            <p className="tryon-room-look-expired-sub">
              Renders are signed for 7 days. Re-try the outfit to refresh.
            </p>
          </div>
        ) : (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="tryon-room-look-image"
            src={look.renderUrl}
            alt={titleList}
            loading="lazy"
            decoding="async"
            onError={() => setImgFailed(true)}
          />
        )}
      </div>
      <div className="tryon-outfit-result-shops">
        {look.itemSnapshots.map((s) => (
          <button
            key={s.id}
            type="button"
            className="tryon-outfit-result-shop"
            onClick={() =>
              window.open(s.affiliateUrl, "_blank", "noopener,noreferrer")
            }
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.imageUrl} alt="" loading="lazy" />
            <span className="tryon-outfit-result-shop-label">
              Shop{s.brand ? ` ${s.brand}` : ""}
            </span>
          </button>
        ))}
      </div>
    </article>
  );
}

function RenderModal({
  state,
  onClose,
}: {
  state: Exclude<RenderState, { state: "idle" }>;
  onClose: () => void;
}) {
  const titleList = state.items
    .map((p) => `${p.brand ? p.brand + " " : ""}${p.name}`)
    .join(", ");
  return (
    <div
      className="tryon-modal-scrim"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div className="tryon-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="tryon-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
        {state.state === "loading" ? (
          <div className="tryon-modal-body tryon-modal-loading">
            <RenderLoadingState
              thumbnails={state.items.map((p) => ({
                src: p.imageUrl,
                alt: p.name,
              }))}
              garmentLabel={state.items.length > 1 ? "your outfit" : titleList}
              expectedSeconds={
                state.items.length > 1
                  ? Math.max(20, state.items.length * 18)
                  : 60
              }
              loaded={false}
            />
          </div>
        ) : null}
        {state.state === "result" ? (
          <div className="tryon-modal-body">
            <BeforeAfterReveal
              beforeUrl={state.beforeSignedUrl}
              afterUrl={state.signedUrl}
              alt={titleList}
            />
            <div className="tryon-modal-caption">{titleList}</div>
            <ResultActions
              beforeUrl={state.beforeSignedUrl}
              afterUrl={state.signedUrl}
              shareTitle={`${titleList} · askmai.co`}
              shopUrl={null}
              shopLabel={null}
            />
            <p className="tryon-room-saved-note">Saved to My looks.</p>
          </div>
        ) : null}
        {state.state === "blocked" ? (
          <div className="tryon-modal-body tryon-modal-blocked">
            <h2>{REASON_COPY[state.reason].title}</h2>
            <p>{REASON_COPY[state.reason].body}</p>
            {REASON_COPY[state.reason].cta ? (
              <a
                className="tryon-btn tryon-btn-primary"
                href={REASON_COPY[state.reason].cta!.href}
              >
                {REASON_COPY[state.reason].cta!.label}
              </a>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
