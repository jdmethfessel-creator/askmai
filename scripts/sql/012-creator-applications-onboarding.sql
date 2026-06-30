-- 012: Extend creator_applications with the inputs needed to re-run
-- the LLM voice generator from the edit page.
--
-- The signup form now collects blog URLs, interview text, additional
-- affiliate URLs (Shopbop / Revolve / FWRD / ShopMy each as their own
-- field), a bio hint, and a slug hint. The voice generator consumes
-- the blog/interview text as its highest-leverage input. When a
-- creator hits "regenerate my voice" from the edit page, we need
-- those original inputs back -- they're not derivable from the
-- creators row alone -- so they live here on the application row.
--
-- resolved_slug + status='live' close the audit loop: once the
-- pipeline finishes, we mark the row done and link it to the
-- creators.slug it produced. Useful for the founder dashboard
-- ("which application became which page") without scanning logs.
--
-- Reverse: ALTER TABLE creator_applications
--            DROP COLUMN blog_urls, DROP COLUMN interview_text,
--            DROP COLUMN affiliate_urls, DROP COLUMN bio_hint,
--            DROP COLUMN slug_hint, DROP COLUMN resolved_slug;
--          ALTER TABLE creator_applications
--            DROP CONSTRAINT creator_applications_status_chk;
--          ALTER TABLE creator_applications
--            ADD CONSTRAINT creator_applications_status_chk
--              CHECK (status IN ('new','reviewing','approved','declined'));

ALTER TABLE public.creator_applications
  ADD COLUMN IF NOT EXISTS blog_urls       JSONB,
  ADD COLUMN IF NOT EXISTS interview_text  TEXT,
  ADD COLUMN IF NOT EXISTS affiliate_urls  JSONB,
  ADD COLUMN IF NOT EXISTS bio_hint        TEXT,
  ADD COLUMN IF NOT EXISTS slug_hint       TEXT,
  ADD COLUMN IF NOT EXISTS resolved_slug   TEXT;

-- Widen the status enum to cover the automated pipeline lifecycle.
-- IF EXISTS drop the old check; recreate including 'processing' and
-- 'live'. Pre-existing rows with the original statuses stay valid.
ALTER TABLE public.creator_applications
  DROP CONSTRAINT IF EXISTS creator_applications_status_chk;

ALTER TABLE public.creator_applications
  ADD CONSTRAINT creator_applications_status_chk
    CHECK (status IN (
      'new',         -- legacy: lead capture only
      'reviewing',   -- legacy
      'approved',    -- legacy
      'declined',    -- legacy
      'processing',  -- pipeline started, not yet complete
      'live',        -- creators row created + hidden=false
      'failed'       -- pipeline failed at a stage (see error_message)
    ));

-- Pipeline failure surface: when something blows up we still write
-- the row + error so the founder dashboard can show what went wrong.
ALTER TABLE public.creator_applications
  ADD COLUMN IF NOT EXISTS error_message TEXT;

CREATE INDEX IF NOT EXISTS creator_applications_resolved_slug_idx
  ON public.creator_applications (resolved_slug)
  WHERE resolved_slug IS NOT NULL;
