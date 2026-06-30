-- 010: Lightweight try-on funnel instrumentation.
--
-- One row per client-side event so JD can measure whether tryable-
-- first ordering actually moves try-on volume. No third-party
-- analytics SDK; no PII; just product/creator/session-scoped
-- counters in our own DB.
--
-- Events emitted by the client (see src/app/_tryon/TryOnGrid.tsx
-- and src/app/[slug]/Chat.tsx onTryOn / runRender hooks):
--
--   'tryon_start'         user clicked Try This On (single)
--                         or Try on this outfit (multi-item)
--   'tryon_complete_ok'   /api/render returned 200; render shipped
--   'tryon_complete_fail' /api/render returned 4xx/5xx; failure_reason
--                         is the route's error code (e.g.
--                         'moderation_blocked', 'no_quota', etc.)
--
-- session_id: ephemeral browser identifier, generated client-side
-- per page load and stored in sessionStorage. Lets us reconstruct a
-- funnel (start -> complete) within a session without persistent
-- tracking. user_id is set when the visitor is signed in.
--
-- Queries this table enables:
--   try-ons per creator per day
--   start -> complete conversion rate
--   per-subcategory try-on rate (does tryable-first move dresses
--     more than the old random-dump did?)
--   failure breakdown (which categories trip moderation most?)

CREATE TABLE IF NOT EXISTS public.tryon_events (
  id              BIGSERIAL PRIMARY KEY,
  event           TEXT NOT NULL,
  creator_slug    TEXT,
  product_external_id  TEXT,
  product_subcategory  TEXT,
  outfit_size     INTEGER,
  duration_ms     INTEGER,
  failure_reason  TEXT,
  session_id      TEXT,
  user_id         UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Volume queries by creator + date
CREATE INDEX IF NOT EXISTS tryon_events_creator_created_idx
  ON public.tryon_events (creator_slug, created_at DESC);

-- Funnel queries (count by event type over a window)
CREATE INDEX IF NOT EXISTS tryon_events_event_created_idx
  ON public.tryon_events (event, created_at DESC);

-- Session-level funnel reconstruction
CREATE INDEX IF NOT EXISTS tryon_events_session_idx
  ON public.tryon_events (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

-- Sample queries (run in Supabase Studio):
--
--   -- try-ons per day for janesmith, last 14 days
--   SELECT date_trunc('day', created_at) AS day,
--          event,
--          count(*)
--     FROM tryon_events
--    WHERE creator_slug = 'janesmith'
--      AND created_at > now() - interval '14 days'
--    GROUP BY 1, 2 ORDER BY 1 DESC, 2;
--
--   -- start -> complete conversion (last 7 days)
--   SELECT creator_slug,
--          count(*) FILTER (WHERE event = 'tryon_start') AS starts,
--          count(*) FILTER (WHERE event = 'tryon_complete_ok') AS oks,
--          count(*) FILTER (WHERE event = 'tryon_complete_fail') AS fails
--     FROM tryon_events
--    WHERE created_at > now() - interval '7 days'
--    GROUP BY 1 ORDER BY starts DESC;
--
--   -- which subcategories drive the most try-ons
--   SELECT product_subcategory, count(*) FROM tryon_events
--    WHERE event = 'tryon_start' AND created_at > now() - interval '7 days'
--    GROUP BY 1 ORDER BY 2 DESC;
