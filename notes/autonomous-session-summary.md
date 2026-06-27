# Autonomous session summary — 2026-06-27

> Worked through your 6-item list while you were away. Everything is on
> branch `feat/jd-followup-board-onboarding`. **Nothing was pushed to
> origin and main is untouched.** Review the branch with
> `git checkout feat/jd-followup-board-onboarding`.

## Pre-flight (step 0)

- ✅ Restored your users row from `/tmp/sub_snapshot.json`:
  `subscription_status='active'`, `plan='monthly'`,
  `stripe_customer_id=cus_Um63e4fstaELv4`,
  `stripe_subscription_id=sub_1TmXrrEPb8kQvEZkO84gOQdz`. Did not touch
  it again.

## Items 1–3 (build tasks, committed to branch)

### 1. Creator onboarding form → Resend email  ✅ COMMITTED
**Files:** `src/app/creator-signup/SignupForm.tsx`, `src/app/api/creator-applications/route.ts`
**Commit:** `ca4126a`

**What changed**
- Added `follower_range` select (Under 10K / 10K–50K / 50K–250K /
  250K–1M / 1M+) and `affiliate_networks` text field to the existing
  `/creator-signup` form.
- The form now captures: name, email, IG/TikTok handles, ShopMy/LTK
  URLs (existing), follower range, affiliate networks, free note.
- API route updated to validate + accept the two new fields, include
  them in the founder notification email, and use the exact subject
  per spec: `New AskMai creator request: <name>`.
- New fields are email-only — not stored in the
  `creator_applications` DB row (no schema column, decision-time
  signal not record-of-truth).

**E2E verification (local)**
- POST to `/api/creator-applications` with full payload returned
  200, row inserted, route logged `RESEND_API_KEY not set — skipping
  notification` (your `.env.local` has the var present-but-empty;
  Vercel env is what's used in prod, and it's set there per the
  pre-existing route history). Test row was deleted.
- The Resend call shape did not change — only the subject string and
  the body row list. The same code path that's been sending emails
  in prod will send these too. No new failure mode introduced.

**To verify the email actually sends as `New AskMai creator
request:`** — push the branch to a Vercel preview deploy and submit
the form there. Or merge to main and submit on prod.

### 2. Board bug — no cards on budget queries  ✅ COMMITTED + VERIFIED
**File:** `src/app/api/chat/route.ts`
**Commits:** `de57d08` + `b330e9a`

**Diagnosis**
Reproduced `"show me a nyc dinner outfit under $200"` against prod:
- **Haiku** (free): prose only ("i'm going to build you a real look"),
  no marker, 0 cards. **Bug confirmed**.
- **Sonnet** (subscribed): emits 4 cards but with messy self-correcting
  prose ("wait, $198 + top + shoes won't fit $200, let me rebuild").

Root cause: Haiku produces vague prose with no specific brand+product
mentions, so all three augmenters (catalog substring, brand-fuzzy,
off-catalog) find nothing to recover. `rankedRecs.length === 0` → no
marker emitted. The system had no server-side fallback layer.

Secondary cause found during fix: `CATEGORY_HINTS` mapped "outfit"
to fashion-only, excluding accessories. And `loadCatalog` returns
top-80 by price DESC, so for Madison's luxury catalog (cheapest
item in top 80 = $369) there's literally nothing under $200 in the
loaded catalog.

**Fix (combined with #3 in same code path)**
- New `inferGarmentKind(name, category)` — classifies recs into
  `anchor_full | top | bottom | layer | shoe | bag | jewelry | other`.
- New `assembleFallbackOutfit(creator, budgetCeiling)` — when a
  budget product request returns 0 cards, queries the catalog
  DIRECTLY (not the pre-loaded top-80) for fashion+accessories
  under budget, classifies, picks `dress + shoe + bag` OR
  `top + bottom + shoe`, resolves through feed tier so cards have
  real shopmy.us links + images.
- `CATEGORY_HINTS` outfit row updated to include `accessories`
  alongside `fashion` so shoes/bags/jewelry are in the catalog
  loaded for the prompt.

**Verification (against local dev server with branch code)**
6 budget queries on both Haiku and Sonnet:

| Query | Haiku | Sonnet |
|---|---|---|
| `show me a nyc dinner outfit under $200` | ✅ 4 cards (Zara pants $70 / & Other Stories cami $55 / Mango shoe $79.99 / H&M bag $40) | ✅ 3 cards (Zara skirt $50 / Zara top $26 / Tony Bianco sandal $190) |
| `beach outfit under $150` | ✅ 4 cards | ✅ 4 cards |
| `cute weekend outfit under $100` | ✅ 3 cards | ✅ 3 cards |

Every single query returned a coherent board with items under the
ceiling. **Bug #2 fixed across both models.**

### 3. Outfit coherence — never dress + standalone tee  ✅ COMMITTED + VERIFIED
**File:** `src/app/api/chat/route.ts` (same commit as #2)

**Fix**
New `pruneIncoherentOutfit(recs)` step between rank and emit. When
the response includes an `anchor_full` garment (dress / gown /
jumpsuit / romper / caftan) AND a standalone top or bottom, drops the
top/bottom and keeps the anchor + layers + accessories. Layers
(jacket/blazer/cardigan/coat) and all accessories pass through
either way.

**Verification (against local dev server)**
4 stress-test queries that explicitly named "dress AND tee":

| Query | Result |
|---|---|
| `wedding guest dinner outfit, give me a dress, top, bag, and heels` | Anchor (Solace London Imani) + shoe + bag + jewelry. Top dropped. ✅ |
| `what should I wear to a fall wedding` | 3 anchors + accessories. No tops/bottoms. ✅ |
| `date night outfit — a slip dress, a tee, sandals` | Anchor + jewelry + shoe. Tee dropped. ✅ |
| `beach outfit with a maxi dress and a fitted tee on top` | Anchor + shoe + bag. Tee dropped. ✅ |

**No board ever pairs a dress + standalone tee.** Bug #3 fixed.

## Items 4–6 (research/prep only, no code)

### 4. Winback verification test script  ✅ DOC
**File:** `notes/winback-fresh-user-test.md`
**Commit:** `152b076`

Step-by-step 9-stage test from incognito + Gmail +alias through
Stripe Checkout discount line confirmation. Includes confirm-points
at each step and diagnostics for the most likely failure modes.
Read before running the test yourself; the winback code itself is
still uncommitted in your working tree as you asked.

### 5. Render feature unit economics  ✅ DOC
**File:** `notes/render-feature-economics.md`

- gpt-image-1 verified at **$0.167 per 1024×1024 high quality**
  (2026-06-27, OpenAI image-generation guide).
- 5 free renders = **$0.835** worst-case CAC contribution per user.
- 15 renders/month cap on $9.99 plan keeps gross margin ~60%.
- Three pricing options for the $9.99 collision; recommend
  **Option A**: include 15 renders/mo in existing $9.99 plan, with
  optional one-time packs (10 / 25 / 50) as soft overage.
- gpt-image-1 deprecation risk flagged; cap should be tunable via
  env var (`RENDER_FREE_TIER_CAP`, `RENDER_PAID_TIER_CAP`).

No API calls made.

### 6. Profile + photo upload spec with age-gate  ✅ DOC
**File:** `notes/profile-photo-upload-spec.md`

- Profile field list + layout sketch.
- **Three required safety layers** for photo upload, in strict order:
  1. **18+ age gate BEFORE the file picker opens.** Server-side at
     `/api/profile/age-verify`, separate route from upload. Stores
     derived `age_verified_at` boolean, NOT raw DOB.
  2. **Three explicit consent checkboxes** on the upload form (this
     is me / not used for training/sharing/marketing / I can delete
     anytime). All start unchecked, no pre-checks ever.
  3. **Storage / retention / delete posture**: private bucket,
     signed URLs only, server-side MIME sniff, 8MB cap, cascade
     delete on account removal, OpenAI zero-data-retention required
     before launch.
- Recommended build order: schema → age-gate → storage policy →
  upload route → upload UI → render integration → moderation.
  **No image-accepting code ships until step 5 lands and age-verify
  works.**

## What's on the branch but NOT in any of my commits

These are still in the working tree, uncommitted. They were there
when I branched. I didn't touch them.

```
M src/app/[slug]/Chat.tsx                       (winback PaywallModal + WinbackModal)
M src/app/api/checkout/route.ts                 (winback coupon param)
?? scripts/stripe-create-winback-coupon.mjs     (winback coupon bootstrap)
?? scripts/test-tryon.mjs                       (try-on spike script, blocked on inputs)
?? scripts/tryon-test/                          (try-on garments, empty people/)
```

When you finish your fresh-user winback verification, decide
separately what to commit and push for those files.

## How to review

```bash
git checkout feat/jd-followup-board-onboarding
git log --oneline main..HEAD          # see the 4 new commits
git diff main..HEAD -- src/           # source changes
git diff main..HEAD -- notes/         # research docs
```

Commits on this branch:

```
152b076  notes: research + spec docs for items 4-6 of the autonomous list
ca4126a  creator-signup: add follower-range + affiliate-networks fields
b330e9a  chat: fallback assembler queries catalog directly for budget items
de57d08  chat: outfit coherence prune + budget-board catalog fallback
```

`main` is exactly where you left it. Nothing was pushed. Merge when
ready, or cherry-pick if you want to ship the bugs first and stage
the onboarding form separately.

## What I deliberately did NOT do per your instructions

- ❌ Did not push the branch to origin (you said stage for review,
  do not push to prod).
- ❌ Did not commit, push, or modify any paywall/winback/payment
  code (left in your working tree).
- ❌ Did not build the photo upload feature (spec only).
- ❌ Did not build the render feature (economics + recommendation
  only, no API calls).
- ❌ Did not touch your subscription row after the initial restore.
- ❌ Did not delete or stash the try-on spike files or the winback
  files in your working tree.

You're back at full state on `main` minus the four new commits on
the branch. Let me know what you want to merge.
