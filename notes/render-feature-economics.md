# Render Feature — Unit Economics & Pricing (LOCKED)

> **Status (2026-06-27):** Pricing model locked below. No code, no API
> calls yet — this is the spec the build will use.

## Current `gpt-image-1` per-image price

Fetched from OpenAI's image-generation guide on
**2026-06-27**:

| Resolution | low | medium | **high** |
|---|---|---|---|
| 1024×1024 | $0.011 | $0.042 | **$0.167** |

Other resolutions (1024×1536, 1536×1024) weren't visible in the same
breakdown but are typically ~1.5× the square. For try-on rendering,
**1024×1024 high** is the locked cost basis — quality matters because
the failure mode (a person rendered with the wrong face / wrong
garment) is more expensive than the API call.

OpenAI also flagged `gpt-image-1` as **legacy** alongside the newer
`gpt-image-2`, `gpt-image-1.5`, `gpt-image-1-mini`. Pricing for the
newer models is per-million-tokens instead of per-image. Worth a
side-by-side cost comparison before launch, but the legacy
`gpt-image-1` is what we have a verified cost for. Build the per-
render cost as an env constant (`RENDER_UNIT_COST_USD`) so the
pricing math is one config edit if the model is swapped.

## Free-tier cost per user (for reference)

Free users get **a one-time pack of 5 renders** to try the feature.
This is the wedge that drives signup — they see real outputs before
hitting the wall.

```
5 renders × $0.167 = $0.835 per free user (worst case, all rendered)
```

| Funnel state | Cost/user |
|---|---|
| User signs up, never uses render | $0.000 |
| User does 1 render, drops off | $0.167 |
| User does 5 renders, drops off (worst case) | $0.835 |
| User does 5 renders → converts to paid | $0.835 (one-time CAC) |

The $0.835 is the upper bound on CAC contribution from the free
render allowance alone.

## LOCKED — Subscription render model

### Included in every subscription (both plans)

**3 renders per calendar month.** Non-poolable. Resets on the 1st of
each month. Same allowance on Monthly $9.99 and Annual $29.99 —
"included in the plan" means the same thing on both.

```
3 renders × $0.167 = $0.501 / mo compute (max)
```

| Plan | Mo. revenue | Mo. compute (max) | Margin $ | Margin % |
|---|---|---|---|---|
| Monthly $9.99 | $9.99 | $0.501 | $9.489 | **94.99%** |
| Annual $29.99/yr → $2.50/mo | $2.50 | $0.501 | $1.999 | **79.96%** |

Both plans clear 75%+ gross margin on render compute even when a
subscriber maxes the included allowance every single month. The
annual plan specifically is healthy at ~80% — the previous 15/mo cap
proposal would have pushed annual into negative territory; the 3/mo
cap fixes that cleanly.

### Render packs (one-time purchases — overage when included is used up)

Packs add to a **balance** on the user's account. Pack renders do
**not** expire — revenue was already collected, so they sit there
until used.

| Pack | Renders | Price | Per-render | Compute | Margin $ | Margin % |
|---|---|---|---|---|---|---|
| 20-pack | 20 | $9.99 | $0.4995 | $3.340 | $6.650 | **66.57%** |
| 50-pack | 50 | $20.99 | $0.4198 | $8.350 | $12.640 | **60.22%** |

The larger pack is **~16% cheaper per render** ($0.42 vs $0.50) —
volume discount that steers heavy users toward the larger pack
without ever making either pack a money-loser.

### Consumption order

When a user clicks "render," the system consumes from this order:

```
  1. Included monthly allowance (3 / month, resets 1st of month)
  2. Pack balance (FIFO across all packs purchased, never expires)
```

This rule means:

- A subscriber with a fresh pack will burn this month's included 3
  first, THEN start consuming pack credits — pack credits live as
  long as possible.
- On the 1st of next month, they get 3 new included credits before
  any further pack consumption.
- A non-subscriber (free tier) has no included allowance; their
  one-time 5-pack is treated as pack balance from day 1.

### What happens when both pools are empty

User UI: "You're out of renders this month. Get more renders →"
The CTA opens a render-pack picker (20 or 50). No timed pressure, no
discount carrot — just the offer.

For subscribers, an additional contextual line: "Next month you'll
get 3 more renders included with your subscription."

### Edge cases the build needs to handle

1. **Sub canceled mid-month**: included balance for the remainder
   of the current month stays available. Pack balance always
   stays. Next month's included does not accrue.
2. **Subscription downgrade / upgrade**: included is plan-tier
   independent (both monthly and annual get 3) so no special case.
3. **Refund of a pack purchase via Stripe**: corresponding render
   credits are deducted from the user's balance. If balance is
   already < the refund amount, balance drops to 0 (no negative
   balance — we eat the small mismatch).
4. **User burns 2 included + buys a 20-pack mid-month**: balance is
   1 (remaining included) + 20 (pack) = 21 available. Spent: 2.
5. **Counter at the storage layer**: needs to track BOTH counters
   atomically per render to avoid the race where two renders fire
   in parallel and both consume the last included credit. Single
   row update with a CASE expression keeps it atomic.

## Schema sketch (informational, not prescriptive)

```sql
-- per-user balances
ALTER TABLE users
  ADD COLUMN renders_included_used_this_month INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN renders_included_period_start    DATE,
  ADD COLUMN renders_pack_balance             INTEGER NOT NULL DEFAULT 0;

-- per-render audit
CREATE TABLE renders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES users(id) NOT NULL,
  tryon_photo_id      UUID REFERENCES tryon_photos(id),
  source              TEXT CHECK (source IN ('included','pack','free_trial')) NOT NULL,
  unit_cost_usd       NUMERIC(6,4) NOT NULL,
  prompt              TEXT,
  output_storage_key  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- per-pack purchases (for refund handling + analytics)
CREATE TABLE render_packs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) NOT NULL,
  size            INTEGER NOT NULL,            -- 20 or 50
  price_usd       NUMERIC(8,2) NOT NULL,
  stripe_session_id TEXT,
  refunded_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The monthly reset is a single nightly cron checking
`renders_included_period_start` — if it's last month, zero out the
counter and stamp the new month. (Or do it lazily on first render
attempt of the month — both work.)

## What this doc deliberately doesn't decide

- Stripe Checkout flow for the pack purchases (one-time
  Payment-mode session vs adding to the existing subscription
  invoice — recommend separate Payment-mode sessions for simplicity
  and refund cleanliness).
- Whether subscribers can stack a discount on pack purchases (no —
  packs are flat-priced, the sub discount applies to the recurring
  charge only).
- A/B test design for measuring conversion lift from renders.
- Free-tier render allowance shape for ANONYMOUS users who haven't
  signed up yet (vs the 5-render one-time pack for users who HAVE
  signed up but aren't subscribed) — likely zero, since rendering is
  the wedge that drives signup itself.

Each of those is a separate doc when we're ready to build that
specific piece. This one is for: what does it cost, what do we
charge.
