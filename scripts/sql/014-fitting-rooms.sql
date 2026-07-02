-- 014: Shared Fitting Rooms -- social multiplayer on top of the
-- existing try-on / wardrobe / saved-looks flow.
--
-- A user creates a room scoped to ONE creator's closet, invites
-- friends via /room/<invite_slug>, and members submit chosen looks
-- into the room. Members react + comment + shop through the same
-- ProductCards + affiliate links as everywhere else.
--
-- Privacy is load-bearing here. Two hard rules the schema
-- structurally enforces:
--   1. Only rows in fitting_room_submissions are visible to a room;
--      the user's private localStorage wardrobe never touches this
--      table. Submits are an explicit user action per look.
--   2. Room-feed reads (submissions/reactions/comments) require the
--      requester to be an active member. Room-info reads (name,
--      creator_slug, member roster) are visible to any invite-link
--      holder. The distinction is enforced at the API-route layer;
--      this schema just provides the membership join key.
--
-- Render images live in the existing private `renders` bucket (see
-- migration 006). Submissions store the storage path only; the API
-- generates a fresh short-lived signed URL per member request. No
-- storage-permission changes needed.
--
-- Reverse (in reverse dependency order):
--   DROP TABLE fitting_room_comments;
--   DROP TABLE fitting_room_reactions;
--   DROP TABLE fitting_room_submissions;
--   DROP TABLE fitting_room_members;
--   DROP TABLE fitting_rooms;

CREATE TABLE IF NOT EXISTS public.fitting_rooms (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  -- Room is scoped to exactly one creator's closet. All submissions
  -- and product-shop actions inside the room resolve against this
  -- creator's creator_products catalog.
  creator_slug TEXT NOT NULL,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Short opaque token that powers /room/<invite_slug>. Unique so
  -- the URL is stable + collision-free. Generated app-side to keep
  -- it URL-friendly (~11 chars, crockford-base32 shape).
  invite_slug  TEXT NOT NULL UNIQUE,
  -- Soft-archive so the host can close a room without losing the
  -- history for members. Archived rooms 404 on /room/<slug> and
  -- reject new submits/reactions/comments.
  is_archived  BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fitting_rooms_name_chk
    CHECK (char_length(name) BETWEEN 1 AND 80)
);

CREATE INDEX IF NOT EXISTS fitting_rooms_host_idx
  ON public.fitting_rooms (host_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fitting_rooms_creator_idx
  ON public.fitting_rooms (creator_slug);

CREATE TABLE IF NOT EXISTS public.fitting_room_members (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID NOT NULL REFERENCES fitting_rooms(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  -- Soft-remove so the host can boot a member without cascading
  -- their prior reactions/comments into inconsistency. removed_at
  -- NULL = active member; NOT NULL = removed, feed reads gate.
  removed_at TIMESTAMPTZ,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (room_id, user_id),
  CONSTRAINT fitting_room_members_role_chk CHECK (role IN ('host','member'))
);

CREATE INDEX IF NOT EXISTS fitting_room_members_user_idx
  ON public.fitting_room_members (user_id);
CREATE INDEX IF NOT EXISTS fitting_room_members_room_idx
  ON public.fitting_room_members (room_id)
  WHERE removed_at IS NULL;

-- Only EXPLICIT submissions land here. The user's localStorage
-- wardrobe never syncs into this table -- submissions are always a
-- deliberate user action per look. This is the load-bearing privacy
-- boundary.
CREATE TABLE IF NOT EXISTS public.fitting_room_submissions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id        UUID NOT NULL REFERENCES fitting_rooms(id) ON DELETE CASCADE,
  submitter_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Storage path in the private renders bucket. The API resigns
  -- per-request when a member loads the feed.
  render_path    TEXT,
  -- Optional pre-render photo storage path (from the try-on
  -- pipeline's "before" image). Same signing pattern as render_path.
  before_path    TEXT,
  -- creator_products.id list for the items in the look. Powers the
  -- room-side ProductCard shop links.
  item_ids       JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Denormalized snapshot: name, brand, imageUrl, affiliateUrl per
  -- item at submit time. Guarantees the shop links keep working even
  -- if the creator's catalog is later re-ingested or a row is
  -- removed. Byte-for-byte the same fields SavedLook stores.
  item_snapshots JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Short optional caption written by the submitter ("bday night?").
  caption        TEXT,
  -- Soft-delete: submitter can delete their own, host can delete
  -- any. Feed reads filter WHERE deleted_at IS NULL.
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fitting_room_submissions_caption_chk
    CHECK (caption IS NULL OR char_length(caption) <= 500)
);

CREATE INDEX IF NOT EXISTS fitting_room_submissions_room_idx
  ON public.fitting_room_submissions (room_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS fitting_room_submissions_submitter_idx
  ON public.fitting_room_submissions (submitter_id);

CREATE TABLE IF NOT EXISTS public.fitting_room_reactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES fitting_room_submissions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Reaction kind: 'upvote' OR 'emoji:<glyph>' (e.g. 'emoji:🔥').
  -- Free-form so the emoji set can grow without a schema change;
  -- the API validates the glyph list before insert.
  kind          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One-per-user-per-reaction-kind so a user can upvote AND drop a
  -- 🔥 emoji separately, but can't stack duplicate upvotes on the
  -- same look. Toggling off = DELETE.
  UNIQUE (submission_id, user_id, kind),
  CONSTRAINT fitting_room_reactions_kind_chk
    CHECK (char_length(kind) BETWEEN 1 AND 32)
);

CREATE INDEX IF NOT EXISTS fitting_room_reactions_submission_idx
  ON public.fitting_room_reactions (submission_id);

CREATE TABLE IF NOT EXISTS public.fitting_room_comments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES fitting_room_submissions(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Threading: NULL for a top-level comment, set to a comment's id
  -- for a reply. One level of depth in the UI; the schema doesn't
  -- enforce the depth cap.
  parent_id     UUID REFERENCES fitting_room_comments(id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  -- Soft-delete: author or host removes; feed hides deleted rows
  -- from render but keeps them for audit.
  deleted_at    TIMESTAMPTZ,
  -- Report action stamps this timestamp for host review. NULL =
  -- not reported.
  reported_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fitting_room_comments_body_chk
    CHECK (char_length(body) BETWEEN 1 AND 2000)
);

CREATE INDEX IF NOT EXISTS fitting_room_comments_submission_idx
  ON public.fitting_room_comments (submission_id, created_at)
  WHERE deleted_at IS NULL;

-- Realtime enablement: publish to the `supabase_realtime` publication
-- so client-side channels can subscribe by room_id. Idempotent add.
-- Publication is Supabase's Realtime default; the ALTER is a no-op
-- if the table is already listed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    -- ALTER PUBLICATION ADD TABLE is idempotent-safe here: if the
    -- table is already in the publication, ALTER succeeds silently
    -- on Postgres 15+. We wrap in EXCEPTION to swallow the
    -- 'relation already in publication' error on older versions.
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.fitting_room_submissions;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.fitting_room_reactions;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.fitting_room_comments;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END $$;
