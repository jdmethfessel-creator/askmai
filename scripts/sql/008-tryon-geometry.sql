-- =====================================================================
-- 008-tryon-geometry.sql
--
-- Phase A of the input-normalization design (see
-- docs/input-normalization-design.md).
--
-- Adds two columns on public.users so the upload route can store
-- both the user's original photo AND a normalized 1024x1536 version
-- that goes into every gpt-image-1 render, with a JSONB blob recording
-- where the head and body landed in the canonical canvas.
--
-- Apply manually via the Supabase SQL editor. Safe to re-run: every
-- column add is guarded with IF NOT EXISTS.
--
--   tryon_original_path   the user's UNMODIFIED uploaded photo, kept
--                          so a future re-normalization (algorithm
--                          improvement, canvas-layout tweak) can run
--                          without forcing a re-upload.
--
--   tryon_geometry        JSONB blob with the canonical canvas
--                          geometry the normalization produced:
--                          {
--                            "version": 1,
--                            "canvas": { "width": 1024, "height": 1536, "color": "#909090" },
--                            "source": { "width": <int>, "height": <int>, "aspect": <float> },
--                            "anchor_used": "head-to-feet" | "head-to-hip" | "head-size",
--                            "scale": <float>,
--                            "partial_body": <bool>,
--                            "source_bboxes": { "person": {...}, "head": {...}, "legs": {...} },
--                            "canvas_layout": { ... where the person landed in 1024x1536 ... }
--                          }
--                          Read by the post-hoc face composite at render time
--                          so it can SKIP the input-image SegFormer call (Phase C).
--
-- tryon_photo_path stays as the column the render route reads from;
-- after this migration it points at the NORMALIZED file for users who
-- have re-uploaded. Existing users (pre-normalization) keep pointing
-- at their raw uploads until they re-upload; renders for them still
-- work, just without normalization benefit, until they touch the
-- upload control again.
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tryon_original_path TEXT,
  ADD COLUMN IF NOT EXISTS tryon_geometry      JSONB;

-- Optional: backfill index for ops queries (e.g. "how many users have
-- normalized photos" / "find users with partial_body geometry").
CREATE INDEX IF NOT EXISTS users_tryon_geometry_version_idx
  ON public.users ((tryon_geometry ->> 'version'));
