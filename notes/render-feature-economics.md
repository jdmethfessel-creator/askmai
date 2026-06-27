# Render Feature — Unit Economics & Pricing

> **Status (2026-06-27):** No code, no API calls. Research and pricing
> proposal only. Decide here before any spend.

## Current `gpt-image-1` per-image price

Fetched from OpenAI's image-generation guide on
**2026-06-27**:

| Resolution | low | medium | **high** |
|---|---|---|---|
| 1024×1024 | $0.011 | $0.042 | **$0.167** |

Other resolutions (1024×1536, 1536×1024) weren't visible in the same
breakdown but are typically ~1.5× the square. For try-on rendering,
1024×1024 high is the working assumption — quality matters because
the failure mode (a person rendered with the wrong face / wrong
garment) is more expensive than the API call.

OpenAI also flagged `gpt-image-1` as **legacy** alongside the newer
`gpt-image-2`, `gpt-image-1.5`, `gpt-image-1-mini`. Pricing for the
newer models is per-million-tokens (input image + text + output
image) instead of per-image. Worth a side-by-side cost comparison
before launch, but the legacy `gpt-image-1` is what we have a verified
cost for.

## Free-tier cost per user (worst case)

Assumption: **5 free renders per user**, high quality, 1024×1024.

```
5 renders × $0.167  =  $0.835  per free user (worst case, all rendered)
```

Realistic conversion-funnel sensitivity:

| Funnel state | Cost/user |
|---|---|
| User signs up, never uses render | $0.000 |
| User does 1 render, drops off | $0.167 |
| User does 3 renders, drops off | $0.501 |
| User does 5 renders, drops off (worst case) | $0.835 |
| User does 5 renders → converts to paid | $0.835 (one-time) |

The $0.835 is the upper bound on CAC contribution from the render
allowance alone. At 10K free signups it's $8,350 in compute. At
100K it's $83,500.

## Paid-plan render cap math

Subscription is **$9.99/month**. Allowable compute = some fraction of
revenue, with margin for the rest of the cost stack (Anthropic API,
Supabase, Vercel, Stripe processing).

Approximate non-render unit cost on the existing $9.99 plan today:

| Component | Est / subscriber / mo |
|---|---|
| Anthropic API (chat) — heavy user | ~$0.50 |
| Supabase + Vercel — amortized | ~$0.30 |
| Stripe processing (2.9% + $0.30) | $0.59 |
| **Subtotal non-render** | **~$1.39** |
| **Render compute budget at 60% gross margin** | **$9.99 × 40% − $1.39 = $2.61** |

That's the headroom for renders before margin drops below 60%.

```
$2.61 ÷ $0.167 per render = 15.6 renders / sub / mo
```

A **monthly cap of 15 renders** keeps worst-case compute at $2.51,
preserving roughly the same margin shape as today. A more
conservative 10/mo cap leaves $1.94 of headroom and protects against
gpt-image-1 price increases.

| Plan render cap | Worst-case compute | Gross margin |
|---|---|---|
| 5 / mo | $0.835 | ~83% |
| 10 / mo | $1.670 | ~75% |
| **15 / mo** | $2.505 | **~60% (target)** |
| 20 / mo | $3.340 | ~46% |

**Recommended cap on the existing $9.99 plan: 15 renders / month.**
Generous enough to feel "unlimited-ish" to a normal user; capped so a
power user can't blow up the cost basis.

## The $9.99 collision problem

The render feature is materially differentiated from the existing
"unlimited chat" pitch. Three pricing patterns to consider:

### Option A — Renders INCLUDED in $9.99/mo, capped at 15/mo

- Sub stays $9.99/mo.
- Includes everything: chat + 15 renders/mo.
- Overage: hard cap at 15. User sees "X renders remaining this month"
  in the UI; on 16th attempt, gentle upsell to a top-up pack.
- Upsell: **paid render packs** as one-time purchases:
  - 10 renders = $2.99 (margin: $1.32, ~44%)
  - 25 renders = $6.99 (margin: $2.82, ~40%)
  - 50 renders = $11.99 (margin: $3.64, ~30%)
  Render packs intentionally lower margin so the implicit message is
  "the cap is generous; if you need more, the sub is cheaper per
  render." Steers heavy users to upgrade rather than buy packs.
- **Pros**: keeps the sub a single SKU; the pitch stays "you get
  AskMai". Renders feel like a built-in feature rather than a tier.
- **Cons**: ~40% margin haircut on the worst-case user (15 renders
  exactly), and we eat the entire CAC on the free → paid bridge.

### Option B — Tier the subscription: existing $9.99 + new $14.99

- Existing $9.99 → "AskMai" (chat + 5 renders/mo).
- New $14.99 → "AskMai Plus" (chat + 30 renders/mo).
- Differentiation is clear, no pack purchases needed for normal use.
- **Pros**: anchored pricing — the $9.99 SKU becomes the "approachable"
  option; $14.99 is the "you actually use it" option. Stripe-clean.
- **Cons**: forces a tier decision at signup; some users will pick
  the cheaper one and bounce on the lower cap.

### Option C — Renders as a separate paid product

- Sub stays $9.99/mo (chat-only, no renders).
- Renders are a separate metered SKU: e.g. 25 renders = $4.99.
- Free users get a one-time pack of 5 renders to try.
- **Pros**: cleanest unit economics — renders self-fund. No margin
  drag on the chat plan.
- **Cons**: the value prop becomes harder to convey. "$9.99 + buy a
  render pack" reads more transactional than the current promise.

## Recommendation

**Option A** — renders included in the existing $9.99 plan, capped at
15/mo, with optional one-time render packs as overage.

Reasoning:

1. **Keeps the SKU simple.** No tier-decision friction at signup, no
   "wait, do I need the Plus version" hesitation. The product
   advertises as "AskMai" and now renders are part of it.
2. **15/mo is genuinely generous.** A user rendering 15 outfits per
   month is engaged in a way that maps directly to retention. We
   want to subsidize that user's compute, not gate them.
3. **The pack overage is a soft fence.** Heavy users (16+/mo) self-
   identify as power users and either buy packs (good revenue) or
   churn (acceptable signal). Either way, the unit economics on the
   pack purchase don't blow up.
4. **Margin is preserved at the average case.** Median paid user will
   render 4–6 times per month based on adjacent-product benchmarks
   (Klarna AI, Pinterest TryOn, etc.), well under the 15 cap, leaving
   ~80% gross margin on that user.
5. **Anchors the existing winback offer.** "50% off your first 3
   months" already exists as the price-sensitivity outlet. Stacking
   another tier ($14.99) on top complicates that flow.

Risk: gpt-image-1 deprecation. If the legacy model is removed and we
have to switch to gpt-image-2 (token-based pricing), the 15-cap math
needs re-running. Build the cap as an env var
(`RENDER_FREE_TIER_CAP`, `RENDER_PAID_TIER_CAP`) so it's tunable
without a code change.

## What's NOT covered in this doc

- Free-tier render allowance for ANONYMOUS users (paywall hit
  pre-signup) — likely zero, since rendering is the wedge that
  drives signup.
- Storage of generated images (CDN bucket cost, retention policy).
- COGS on the input person photo upload (Supabase Storage egress).
- A/B test design for measuring conversion lift from renders.

Each of those is a separate doc when we're ready to build. This one
is for: should we build it, and at what price.
