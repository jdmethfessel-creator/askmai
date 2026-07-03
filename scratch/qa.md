# Phase 7 QA checklist run

Not user-facing. Internal record of the sweep.

## Build + typecheck

`rm -rf .next && npx next build` passes clean at HEAD. Route sizes
match expectations; no compile errors, no missing modules after the
_marketing/landing.css deletion.

## Affiliate URL invariant

`git diff ba9b45f..HEAD -- '*.ts' '*.tsx' '*.mjs' | grep affiliate_url`
returns pass-through only: reads from creator_products, writes
back through window.open, <a href>, and the byte-for-byte column
select. No string manipulation of the URL anywhere. Ingest parser
(scripts/ingest-creator-products/parsers.mjs) is untouched.

## Tone rules

`grep '—'` returns zero matches in user-facing paths (page.tsx,
forcreators, _marketing, _pullsheet, salesEmail).

`grep '\bAI\b'` returns one match, and it's inside a code comment
in lib/salesEmail.ts documenting the tone rule itself. No user-
facing string uses the word.

## Cron auth

`curl -sSI https://www.askmai.co/api/cron/price-check` returns 401
without the header. Route accepts either x-cron-secret or
Authorization: Bearer <CRON_SECRET>.

## Migration-degradation

/api/watch:      route inserts, `ensureWatch` swallows missing-table
                 errors and returns null; UI treats null as "no-op".
/api/for-less:   loadAnchor + getForLess return empty on missing
                 creator_products (still exists) or empty on 0
                 candidates.
/api/looks:      createLook wraps in try/catch; returns null on
                 missing table, POST returns 500 which the client's
                 ShareTheLook surfaces as "Sharing isn't available
                 yet." tooltip.
/api/cron/price-check: wraps schema reads in try/catch; returns
                 {ok:false, error:"schema_missing"} rather than
                 crashing.
FitRecPanel, WatchToggle, ForLessBand, ShareTheLook: all silent-
render-null on 500 responses from their endpoints.
Products endpoint: SELECT_COLS falls through
  SELECT_COLS -> SELECT_COLS_NO_SALE -> SELECT_COLS_NO_FEATURED
on 42703 (column does not exist), so a fresh env still returns
rows without featured / on_sale / mai_note.

## Homepage + /forcreators copy audit

Every headline + body verbatim from the spec. No paraphrase, no
added marketing copy. Creator names only appear inside the
featured closets grid, populated from live `creators` rows via
supabaseAdmin (hidden filter + fallback path in place).

## Mobile 390px

CSS media queries at max-width 480 in:
  homepage.css        (hero tightens, sections tighten, footer stacks)
  forcreators.css     (hero tightens, sections tighten, money block
                       tightens, footer stacks)
  _pullsheet/tokens.css (hang tag grid stays 2-col mobile)
Visual verification pending real-device viewport check; no
overflow/leak-inducing widths introduced this pass.

## Look card

/look/[slug] renders even when the looks table is missing (page
falls through to "This pull sheet doesn't exist." with a Back Home
button). OG image at /look/[slug]/opengraph-image via next/og.

## Known follow-ups intentionally deferred

- Corner "for less" label on Shop grid cards (would require an
  N-way qualification pass per grid load; the modal + Ask surfaces
  are higher-signal).
- Ask chat "Share the look" button on Mai-composed outfits (would
  require plumbing through Chat.tsx's 2583-line message rendering;
  the DressingRoom Share path covers the primary flow).
- OnSaleRail item selection is limited to the current page of
  products; not the full catalog. Fine for launch; upgrade with
  a small /api/tryon-grid/[slug]/on-sale endpoint later.
- next/font Bodoni Moda "font override values" warning at build
  time is cosmetic (Google no longer ships the reference metrics
  for that font in Next 14's font-loader table); the fonts still
  load correctly at runtime.
