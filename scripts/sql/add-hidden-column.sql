-- Adds a `hidden` boolean flag to creators. Hidden creators are filtered
-- out of the /creators directory and their /[slug] pages return 404.
-- All their data, voice, and config stays intact — flipping back to
-- false fully restores visibility.

ALTER TABLE creators
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;

-- This creator is temporarily hidden. Flip back to false to restore.
-- (Slug renamed from "cass" -> "janesmith"; hidden state was preserved
-- across the rename so this UPDATE remains a no-op replay against the
-- already-hidden row.)
UPDATE creators
  SET hidden = true
  WHERE slug = 'janesmith';
