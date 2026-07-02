"use client";

/**
 * Shared Fitting Room client — orchestrates the /room surface end to
 * end: info fetch, join, submissions feed, reactions, comments, and
 * host controls. Mobile-first (390px baseline).
 *
 * State machine:
 *   loading            initial fetch of /api/rooms/[slug]
 *   need-signin        anon viewer; open SignInModal, capture returnTo
 *   need-join          signed-in viewer who is not yet a member
 *   ready              active member; feed loaded
 *   archived           room archived; read-only state
 *   not-found          slug resolved on the server, deleted since page load
 *
 * Feed refresh: polls every ROOM_POLL_MS while the tab is visible.
 * Realtime layers on top in Rooms D; this component exposes a
 * `refreshFeed()` handle that a future subscription will call.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SignInModal from "../../_components/SignInModal";
import { loadDressingRoom, type SavedLook } from "../../_tryon/dressingRoomStore";
import { EMOJI_ALLOWLIST } from "@/lib/rooms";
import { supabaseBrowser } from "@/lib/supabaseBrowser";
import "./room.css";

// Polling floor. Realtime broadcast drives refreshes near-instantly
// when the WebSocket is healthy; polling is the guaranteed floor so a
// dead socket never leaves the feed stale. 10s while visible.
const ROOM_POLL_MS = 10_000;

// Coalesce a burst of broadcast events into a single feed refetch.
// Reactions in particular can fire in tight bursts.
const REFRESH_DEBOUNCE_MS = 300;

type Viewer = {
  user_id: string;
  is_member: boolean;
  role: "host" | "member" | null;
  is_host: boolean;
} | null;

type MemberInfo = {
  user_id: string;
  role: string;
  joined_at: string;
  display_name: string;
};

type Comment = {
  id: string;
  user_id: string;
  display_name: string;
  parent_id: string | null;
  body: string;
  created_at: string;
};

type FeedItem = {
  id: string;
  submitter_id: string;
  submitter_display_name: string;
  render_url: string | null;
  before_url: string | null;
  item_snapshots: Array<{
    id: string;
    name: string;
    brand?: string | null;
    imageUrl: string;
    affiliateUrl: string;
  }>;
  caption: string | null;
  created_at: string;
  reaction_counts: Record<string, number>;
  viewer_reaction_kinds: string[];
  comments: Comment[];
};

type RoomInfo = {
  id: string;
  name: string;
  creator_slug: string;
  host_user_id: string;
  invite_slug: string;
  is_archived: boolean;
  created_at: string;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "need-signin"; room: RoomInfo; members: MemberInfo[] }
  | { kind: "need-join"; room: RoomInfo; members: MemberInfo[] }
  | {
      kind: "ready";
      room: RoomInfo;
      viewer: NonNullable<Viewer>;
      members: MemberInfo[];
      feed: FeedItem[];
    }
  | { kind: "archived"; room: RoomInfo; members: MemberInfo[] }
  | { kind: "not-found" };

export default function RoomClient({
  inviteSlug,
  initialName,
  creatorSlug,
  isArchived,
}: {
  inviteSlug: string;
  initialName: string;
  creatorSlug: string;
  isArchived: boolean;
}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [showSignIn, setShowSignIn] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const fetchInfo = useCallback(async (): Promise<{
    room: RoomInfo;
    members: MemberInfo[];
    viewer: Viewer;
  } | null> => {
    const res = await fetch(`/api/rooms/${inviteSlug}`, {
      credentials: "same-origin",
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const json = await res.json();
    return {
      room: json.room as RoomInfo,
      members: (json.members as MemberInfo[]) ?? [],
      viewer: json.viewer as Viewer,
    };
  }, [inviteSlug]);

  const fetchFeed = useCallback(async (): Promise<FeedItem[] | null> => {
    const res = await fetch(`/api/rooms/${inviteSlug}/feed`, {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const json = await res.json();
    return (json.submissions as FeedItem[]) ?? [];
  }, [inviteSlug]);

  const reload = useCallback(async () => {
    const info = await fetchInfo();
    if (!info) {
      setState({ kind: "not-found" });
      return;
    }
    if (info.room.is_archived) {
      setState({ kind: "archived", room: info.room, members: info.members });
      return;
    }
    if (!info.viewer) {
      setState({ kind: "need-signin", room: info.room, members: info.members });
      return;
    }
    if (!info.viewer.is_member) {
      setState({ kind: "need-join", room: info.room, members: info.members });
      return;
    }
    const feed = (await fetchFeed()) ?? [];
    setState({
      kind: "ready",
      room: info.room,
      viewer: info.viewer,
      members: info.members,
      feed,
    });
  }, [fetchFeed, fetchInfo]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Refresh only the feed slice of the state (leaves room + viewer +
  // members alone). Debounced so a burst of broadcast events lands as
  // one refetch.
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFeed = useCallback(() => {
    if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
    refreshDebounceRef.current = setTimeout(async () => {
      if (stateRef.current.kind !== "ready") return;
      const feed = await fetchFeed();
      if (!feed) return;
      setState((prev) => (prev.kind === "ready" ? { ...prev, feed } : prev));
    }, REFRESH_DEBOUNCE_MS);
  }, [fetchFeed]);

  // Realtime layer: subscribe to a broadcast channel scoped to this
  // room's invite slug. The channel carries no row payload -- only a
  // "changed" ping -- so a rogue subscriber learns nothing beyond
  // "the room had activity." All actual content still flows through
  // /api/rooms/[slug]/feed which enforces membership. When the socket
  // is healthy, refreshes land in ~one round trip; if it never
  // connects, polling below keeps the feed within ROOM_POLL_MS.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const client = supabaseBrowser();
    const channel = client.channel(`room:${inviteSlug}`, {
      config: { broadcast: { self: false, ack: false } },
    });
    channel.on("broadcast", { event: "changed" }, () => {
      // Roster changes need the room-info refresh; feed-only changes
      // can go through the cheap refreshFeed path. We don't distinguish
      // here because both reload() and refreshFeed are idempotent; a
      // full reload() on every broadcast is the safe default and the
      // debounce keeps it cheap.
      if (stateRef.current.kind === "ready") {
        refreshFeed();
      } else {
        reload();
      }
    });
    channel.subscribe();
    return () => {
      client.removeChannel(channel);
    };
  }, [inviteSlug, refreshFeed, reload]);

  // Polling floor. Runs regardless of realtime health.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      const s = stateRef.current;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "hidden" &&
        s.kind === "ready"
      ) {
        const feed = await fetchFeed();
        if (!cancelled && feed) {
          setState((prev) =>
            prev.kind === "ready" ? { ...prev, feed } : prev
          );
        }
      }
      if (!cancelled) {
        timer = setTimeout(tick, ROOM_POLL_MS);
      }
    }

    timer = setTimeout(tick, ROOM_POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchFeed]);

  const onJoin = useCallback(async () => {
    const res = await fetch(`/api/rooms/${inviteSlug}/join`, {
      method: "POST",
      credentials: "same-origin",
    });
    if (res.status === 401) {
      setShowSignIn(true);
      return;
    }
    if (!res.ok) {
      alert("Couldn't join this room. Try again in a moment.");
      return;
    }
    await reload();
  }, [inviteSlug, reload]);

  const onSubmitted = useCallback(async () => {
    setShowSubmit(false);
    await reload();
  }, [reload]);

  if (state.kind === "loading") {
    return (
      <main className="room-page">
        <div className="room-loading">
          <div className="room-loading-title">{initialName}</div>
          <div className="room-loading-sub">Loading the room…</div>
        </div>
      </main>
    );
  }

  if (state.kind === "not-found") {
    return (
      <main className="room-page room-page-empty">
        <div className="room-empty-card">
          <h1>Room not found</h1>
          <p>This invite link is expired or the room was removed.</p>
          <a className="room-btn room-btn-primary" href="/">
            Go home
          </a>
        </div>
      </main>
    );
  }

  if (state.kind === "archived") {
    return (
      <main className="room-page room-page-empty">
        <div className="room-empty-card">
          <h1>{state.room.name}</h1>
          <p>This room has been closed by the host.</p>
        </div>
      </main>
    );
  }

  if (state.kind === "need-signin") {
    return (
      <main className="room-page">
        <RoomHeader
          name={state.room.name}
          creatorSlug={state.room.creator_slug}
          members={state.members}
        />
        <div className="room-join-card">
          <p className="room-join-title">You've been invited</p>
          <p className="room-join-sub">
            Sign in with a magic link to join. You can join to vote and
            chat even if you don't try anything on.
          </p>
          <button
            type="button"
            className="room-btn room-btn-primary"
            onClick={() => setShowSignIn(true)}
          >
            Sign in to join
          </button>
        </div>
        {showSignIn ? (
          <SignInModal
            onClose={() => setShowSignIn(false)}
            title="Sign in to join"
            subtitle="One-tap email link. We'll bring you right back here."
          />
        ) : null}
      </main>
    );
  }

  if (state.kind === "need-join") {
    return (
      <main className="room-page">
        <RoomHeader
          name={state.room.name}
          creatorSlug={state.room.creator_slug}
          members={state.members}
        />
        <div className="room-join-card">
          <p className="room-join-title">You've been invited</p>
          <p className="room-join-sub">
            Join to see what everyone's trying on, drop reactions, and
            comment. Submitting your own look is optional.
          </p>
          <button
            type="button"
            className="room-btn room-btn-primary"
            onClick={onJoin}
          >
            Join room
          </button>
        </div>
      </main>
    );
  }

  const { room, viewer, members, feed } = state;

  return (
    <main className="room-page">
      <RoomHeader
        name={room.name}
        creatorSlug={room.creator_slug}
        members={members}
        viewer={viewer}
        onRemoveMember={
          viewer.is_host
            ? async (userId: string) => {
                const confirmed = confirm("Remove this member from the room?");
                if (!confirmed) return;
                await fetch(
                  `/api/rooms/${inviteSlug}/members/${userId}`,
                  { method: "DELETE", credentials: "same-origin" }
                );
                await reload();
              }
            : undefined
        }
      />

      <div className="room-submit-row">
        <button
          type="button"
          className="room-btn room-btn-primary room-btn-block"
          onClick={() => setShowSubmit(true)}
        >
          Submit a look
        </button>
      </div>

      {feed.length === 0 ? (
        <div className="room-feed-empty">
          <p>Nothing submitted yet.</p>
          <p className="room-feed-empty-sub">
            Be first: try something on and drop it here.
          </p>
        </div>
      ) : (
        <ul className="room-feed">
          {feed.map((item) => (
            <li key={item.id}>
              <SubmissionCard
                inviteSlug={inviteSlug}
                item={item}
                viewer={viewer}
                hostUserId={room.host_user_id}
                onChanged={reload}
              />
            </li>
          ))}
        </ul>
      )}

      {showSubmit ? (
        <SubmitLookModal
          inviteSlug={inviteSlug}
          creatorSlug={creatorSlug}
          onClose={() => setShowSubmit(false)}
          onSubmitted={onSubmitted}
        />
      ) : isArchived ? null : null}
    </main>
  );
}

function RoomHeader({
  name,
  creatorSlug,
  members,
  viewer,
  onRemoveMember,
}: {
  name: string;
  creatorSlug: string;
  members: MemberInfo[];
  viewer?: NonNullable<Viewer>;
  onRemoveMember?: (userId: string) => Promise<void> | void;
}) {
  return (
    <header className="room-header">
      <div className="room-header-title">
        <h1 className="room-title">{name}</h1>
        <a className="room-creator-link" href={`/${creatorSlug}`}>
          {creatorSlug}
        </a>
      </div>
      <div className="room-members">
        {members.map((m) => (
          <div
            key={m.user_id}
            className={`room-member ${m.role === "host" ? "is-host" : ""}`}
          >
            <span className="room-member-name">
              {m.display_name}
              {m.role === "host" ? " · host" : ""}
              {viewer?.user_id === m.user_id ? " · you" : ""}
            </span>
            {onRemoveMember && m.role !== "host" && viewer?.user_id !== m.user_id ? (
              <button
                type="button"
                className="room-member-remove"
                aria-label={`Remove ${m.display_name}`}
                onClick={() => onRemoveMember(m.user_id)}
              >
                ✕
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </header>
  );
}

function SubmissionCard({
  inviteSlug,
  item,
  viewer,
  hostUserId,
  onChanged,
}: {
  inviteSlug: string;
  item: FeedItem;
  viewer: NonNullable<Viewer>;
  hostUserId: string;
  onChanged: () => Promise<void> | void;
}) {
  const isHost = viewer.user_id === hostUserId;
  const isSubmitter = viewer.user_id === item.submitter_id;
  const canDelete = isHost || isSubmitter;
  const [showComments, setShowComments] = useState(false);

  const upvoteCount = item.reaction_counts["upvote"] ?? 0;
  const upvoted = item.viewer_reaction_kinds.includes("upvote");

  const toggleReaction = useCallback(
    async (kind: string) => {
      await fetch(
        `/api/rooms/${inviteSlug}/submissions/${item.id}/reactions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ kind }),
        }
      );
      await onChanged();
    },
    [inviteSlug, item.id, onChanged]
  );

  const onDelete = useCallback(async () => {
    const confirmed = confirm("Remove this look?");
    if (!confirmed) return;
    await fetch(
      `/api/rooms/${inviteSlug}/submissions/${item.id}`,
      { method: "DELETE", credentials: "same-origin" }
    );
    await onChanged();
  }, [inviteSlug, item.id, onChanged]);

  return (
    <article className="room-sub">
      <div className="room-sub-image-wrap">
        {canDelete ? (
          <button
            type="button"
            className="room-sub-remove"
            aria-label="Remove look"
            onClick={onDelete}
          >
            ✕
          </button>
        ) : null}
        {item.render_url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            className="room-sub-image"
            src={item.render_url}
            alt={`Look submitted by ${item.submitter_display_name}`}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="room-sub-image-missing">Image unavailable</div>
        )}
      </div>

      <div className="room-sub-meta">
        <div className="room-sub-submitter">{item.submitter_display_name}</div>
        {item.caption ? (
          <div className="room-sub-caption">{item.caption}</div>
        ) : null}
      </div>

      {item.item_snapshots.length > 0 ? (
        <div className="room-sub-shops">
          {item.item_snapshots.map((s) => (
            <button
              key={s.id}
              type="button"
              className="room-sub-shop"
              onClick={() =>
                window.open(s.affiliateUrl, "_blank", "noopener,noreferrer")
              }
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.imageUrl} alt="" loading="lazy" decoding="async" />
              <span className="room-sub-shop-label">
                Shop{s.brand ? ` ${s.brand}` : ""}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="room-sub-reactions">
        <button
          type="button"
          className={`room-rx room-rx-upvote ${upvoted ? "is-on" : ""}`}
          onClick={() => toggleReaction("upvote")}
          aria-pressed={upvoted}
          aria-label="Upvote"
        >
          <span aria-hidden>▲</span>
          <span>{upvoteCount}</span>
        </button>
        {EMOJI_ALLOWLIST.map((glyph) => {
          const kind = `emoji:${glyph}`;
          const on = item.viewer_reaction_kinds.includes(kind);
          const count = item.reaction_counts[kind] ?? 0;
          return (
            <button
              key={glyph}
              type="button"
              className={`room-rx room-rx-emoji ${on ? "is-on" : ""}`}
              onClick={() => toggleReaction(kind)}
              aria-pressed={on}
              aria-label={`React ${glyph}`}
            >
              <span aria-hidden>{glyph}</span>
              {count > 0 ? <span>{count}</span> : null}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="room-sub-comments-toggle"
        onClick={() => setShowComments((v) => !v)}
      >
        {showComments
          ? "Hide comments"
          : `Comments${item.comments.length > 0 ? ` (${item.comments.length})` : ""}`}
      </button>

      {showComments ? (
        <CommentsPanel
          inviteSlug={inviteSlug}
          submissionId={item.id}
          comments={item.comments}
          viewer={viewer}
          hostUserId={hostUserId}
          onChanged={onChanged}
        />
      ) : null}
    </article>
  );
}

function CommentsPanel({
  inviteSlug,
  submissionId,
  comments,
  viewer,
  hostUserId,
  onChanged,
}: {
  inviteSlug: string;
  submissionId: string;
  comments: Comment[];
  viewer: NonNullable<Viewer>;
  hostUserId: string;
  onChanged: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const post = useCallback(async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    const res = await fetch(
      `/api/rooms/${inviteSlug}/submissions/${submissionId}/comments`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
    setPosting(false);
    if (res.ok) {
      setDraft("");
      await onChanged();
    }
  }, [draft, inviteSlug, onChanged, posting, submissionId]);

  const removeComment = useCallback(
    async (commentId: string) => {
      const confirmed = confirm("Remove this comment?");
      if (!confirmed) return;
      await fetch(
        `/api/rooms/${inviteSlug}/comments/${commentId}`,
        { method: "DELETE", credentials: "same-origin" }
      );
      await onChanged();
    },
    [inviteSlug, onChanged]
  );

  return (
    <div className="room-comments">
      <ul className="room-comments-list">
        {comments.map((c) => {
          const canRemove =
            viewer.user_id === c.user_id || viewer.user_id === hostUserId;
          return (
            <li key={c.id} className="room-comment">
              <div className="room-comment-head">
                <span className="room-comment-name">{c.display_name}</span>
                {canRemove ? (
                  <button
                    type="button"
                    className="room-comment-remove"
                    aria-label="Remove comment"
                    onClick={() => removeComment(c.id)}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <div className="room-comment-body">{c.body}</div>
            </li>
          );
        })}
        {comments.length === 0 ? (
          <li className="room-comment-empty">No comments yet.</li>
        ) : null}
      </ul>
      <div className="room-comment-form">
        <textarea
          className="room-comment-input"
          placeholder="Add a comment"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") post();
          }}
          rows={2}
        />
        <button
          type="button"
          className="room-btn room-btn-primary room-comment-post"
          onClick={post}
          disabled={posting || !draft.trim()}
        >
          {posting ? "Posting…" : "Post"}
        </button>
      </div>
    </div>
  );
}

function SubmitLookModal({
  inviteSlug,
  creatorSlug,
  onClose,
  onSubmitted,
}: {
  inviteSlug: string;
  creatorSlug: string;
  onClose: () => void;
  onSubmitted: () => Promise<void> | void;
}) {
  const [looks, setLooks] = useState<SavedLook[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const room = loadDressingRoom(creatorSlug);
    // A saved look without a renderPath was captured before rooms
    // plumbing landed; server-side submit needs the path to resign.
    setLooks(room.looks.filter((l) => Boolean(l.renderPath)));
    setSelectedId(
      room.looks.find((l) => Boolean(l.renderPath))?.id ?? null
    );
  }, [creatorSlug]);

  const selected = useMemo(
    () => looks.find((l) => l.id === selectedId) ?? null,
    [looks, selectedId]
  );

  const submit = useCallback(async () => {
    if (!selected || !selected.renderPath || submitting) return;
    setSubmitting(true);
    const res = await fetch(
      `/api/rooms/${inviteSlug}/submissions`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          renderPath: selected.renderPath,
          beforePath: selected.beforePath ?? null,
          itemIds: selected.itemIds,
          itemSnapshots: selected.itemSnapshots,
          caption: caption.trim() || null,
        }),
      }
    );
    setSubmitting(false);
    if (res.ok) {
      await onSubmitted();
    } else {
      alert("Submit failed. Try again in a moment.");
    }
  }, [caption, inviteSlug, onSubmitted, selected, submitting]);

  return (
    <div className="room-modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="room-modal" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="room-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ✕
        </button>
        <h2 className="room-modal-title">Submit a look</h2>
        {looks.length === 0 ? (
          <div className="room-modal-empty">
            <p>You haven't tried anything on for this creator yet.</p>
            <p>
              Head to{" "}
              <a className="room-modal-link" href={`/${creatorSlug}`}>
                {creatorSlug}
              </a>{" "}
              and try something on first. Your looks show up here.
            </p>
          </div>
        ) : (
          <>
            <p className="room-modal-sub">
              Pick a look from your Dressing Room.
            </p>
            <ul className="room-look-picker">
              {looks.map((l) => (
                <li key={l.id}>
                  <button
                    type="button"
                    className={`room-look-thumb ${selectedId === l.id ? "is-on" : ""}`}
                    onClick={() => setSelectedId(l.id)}
                    aria-pressed={selectedId === l.id}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={l.renderUrl} alt="" loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
            <textarea
              className="room-modal-caption"
              placeholder="Optional caption (bday night?)"
              value={caption}
              maxLength={500}
              rows={2}
              onChange={(e) => setCaption(e.target.value)}
            />
            <button
              type="button"
              className="room-btn room-btn-primary room-btn-block"
              onClick={submit}
              disabled={submitting || !selected}
            >
              {submitting ? "Submitting…" : "Submit"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
