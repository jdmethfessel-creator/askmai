# Recon for the pull-sheet rebrand

Working notes only. Not user-facing.

## Routes

- `/` homepage (server component, renders Marketing client)
- `/forcreators` pitch page (server component)
- `/creators` directory (server component, lists creators from `creators` table)
- `/[slug]` creator page with three-tab Shop / Ask / Try On (Chat.tsx, TryOnGrid.tsx, DressingRoom.tsx)
- `/profile` (client wrapper)
- `/room/[invite_slug]` shared fitting rooms
- `/creator-signup`, `/creator-edit/[token]`

## Product card

- One shared component `src/app/_tryon/ProductCard.tsx`
- Product shape includes `id, source_network, product_title, brand, price, price_display, image_url, affiliate_url, product_category, product_subcategory, featured`
- Affiliate URL opens via `window.open(product.affiliate_url, ...)` byte-for-byte; do not touch
- Rendered by both Shop grid (TryOnGrid.tsx) and Ask (Chat.tsx)

## Ask chat

- `src/app/[slug]/Chat.tsx` (2583 lines) is the client
- `src/app/api/chat/route.ts` streams Anthropic Sonnet or Haiku, system prompt built by `src/lib/mai/systemPrompt.ts`
- Recs come back as inline `Rec[]` array separated by `---RECS---` marker in the stream; client renders `ProductCard` per rec
- "Honesty rule" text lands as prose; no distinct DOM anchor yet, will add one

## Try On + Dressing Room

- `src/app/_tryon/TryOnGrid.tsx` (684 lines) is the Shop grid surface
- `src/app/_tryon/DressingRoom.tsx` is the Try On tab
- Result modal in DressingRoom uses BeforeAfterReveal.tsx
- Sticky bottom tray of selected items, run render CTA
- FitProfileDialog + FitRecPanel newly added

## Share card

- `src/lib/shareCard.ts` composes 1080x1920 PNG via `@napi-rs/canvas` and sharp
- Not tied to the new "Look card" share artifact (Phase 5); Look card is a separate `/look/[slug]` route

## Supabase

- Client factory `src/lib/supabase.ts` (admin + anon)
- Types are ad-hoc inline (no generated types file)
- Tables of interest today: `creators`, `creator_products`, `renders`, `users`, `fitting_rooms*`, `product_fit` (pending migration)

## Catalog sync / price write points

- `scripts/ingest-creator-products/cli.mjs` upserts `creator_products` (bulk ingest)
- No cron sync job; catalog is refreshed by running the ingest CLI by hand
- `price` is `numeric` on `creator_products`, `price_display` is the human-readable string
- Sale-alerts snapshot hook lands at the ingest upsert path

## Affiliate URL invariant

- Composed once per network in `scripts/ingest-creator-products/parsers.mjs` and stored verbatim
- Read at `src/lib/resolveLink.ts` and everywhere consumers open the URL
- Nothing in the app strips, sorts, or re-encodes affiliate params. Preserve on every phase.

## Tailwind + tokens today

- `tailwind.config.ts` extends colors from CSS variables (`--bg`, `--ink`, `--muted`, `--accent`, `--surface`) and fonts from `--font-sans` / `--font-serif`
- `src/app/globals.css` sets `--bg: #faf7f2`, `--ink: #1c1a17`, `--accent: #b8746a`, and body defaults
- Layout imports Fraunces + Manrope via `src/app/page.tsx` (homepage) and per-page next/font on other pages
- Two big page-scoped stylesheets in play: `src/app/_tryon/tryon.css` (1360+ lines), `src/app/_marketing/landing.css`

## Fonts + email

- Resend integrated via `resend` package
- `@vercel/og` not installed; `next/og` `ImageResponse` is available for OG images (used by icon.tsx already)

## Homepage-facing constraints

- `src/app/page.tsx` metadata sets a description tied to the follower-facing pivot
- `src/app/creators/page.tsx` reads `creators` table, filters by `hidden` when column exists, returns `id, slug, name, bio, avatar_url, taste_profile, theme`
