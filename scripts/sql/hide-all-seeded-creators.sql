-- One-off: soft-hide all five seeded creators. Their rows, taste
-- profiles, catalogs, and voice configs stay intact. To restore any
-- one of them, flip `hidden = false` on that row.
UPDATE creators
  SET hidden = true
  WHERE slug IN (
    'janesmith',
    'tezza',
    'weworewhat',
    'somethingnavy',
    'emilyhenderson'
  );

-- Sanity check.
SELECT slug, name, hidden
  FROM creators
  ORDER BY created_at;
