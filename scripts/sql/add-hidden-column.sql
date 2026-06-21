-- Adds a `hidden` boolean flag to creators. Hidden creators are filtered
-- out of the /creators directory and their /[slug] pages return 404.
-- All their data, voice, and config stays intact — flipping back to
-- false fully restores visibility.

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;

-- Cass is temporarily hidden. Flip back to false to restore.
UPDATE creators
  SET hidden = true
  WHERE slug = 'cass';
