-- =====================================================================
-- 005-profile-age-gate.sql
--
-- Profile page + 18+ age gate + try-on photo upload (PHASE 1).
--
-- Apply manually via the Supabase SQL editor. Safe to re-run: every
-- column add and bucket insert is guarded with IF NOT EXISTS or
-- ON CONFLICT DO NOTHING.
--
-- Three additive columns on public.users:
--
--   age_verified_at   timestamptz, NULL = closed (no upload allowed).
--                     Populated only by POST /api/profile/age-verify
--                     after the server-side age computation passes.
--                     We store ONLY the moment of verification, never
--                     the date of birth itself. The DOB enters the
--                     route, is compared to today, and is dropped.
--                     CCPA/GDPR friendlier: nothing to disclose.
--
--   display_name      text, NULL = unset. User-editable on the
--                     profile page; used as the chat greeting once
--                     populated. No length constraint in SQL; the
--                     update route caps at 80 chars.
--
--   tryon_photo_path  text, NULL = no photo uploaded. Stores the
--                     storage key (e.g. "<userId>/abc123.jpg") inside
--                     the tryon-photos bucket. The bucket is private;
--                     the path is accessed only via signed URLs the
--                     server generates per request.
--
-- Plus one private storage bucket for the photos themselves. Server
-- side reads and writes go through the service role (which bypasses
-- storage RLS) so we do not need per-user storage policies in this
-- phase. The bucket being non-public is the gate.
-- =====================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS age_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS display_name    text,
  ADD COLUMN IF NOT EXISTS tryon_photo_path text;

-- Private storage bucket for try-on photos.
--   public = false             : no anonymous read; signed URL only.
--   file_size_limit            : matches the route cap (8 MiB).
--   allowed_mime_types         : matches the route allowlist; Supabase
--                                rejects mismatches at upload time as
--                                a second layer beyond the route.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tryon-photos',
  'tryon-photos',
  false,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO NOTHING;
