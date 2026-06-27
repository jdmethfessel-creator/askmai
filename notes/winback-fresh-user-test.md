# Winback Verification — Fresh User Test Script

> **Status (2026-06-27):** Winback code is committed locally in working
> tree but NOT in any branch commit and NOT deployed. This doc is the
> step-by-step fresh-user test to run on the dev server BEFORE deciding
> whether to push to prod.

## Pre-conditions

- Local repo: `~/askmai`
- Branch: `main` (winback edits are uncommitted there)
- Dev server: `npm run dev` running on `http://localhost:3000`
- Stripe coupon `paywall_winback_50` already exists in **live** Stripe
  (created by `scripts/stripe-create-winback-coupon.mjs`, idempotent).
- `STRIPE_WINBACK_COUPON_ID=paywall_winback_50` in `.env.local`
  (already appended).
- `STRIPE_WINBACK_COUPON_ID` NOT yet set on Vercel — set this BEFORE
  any push to prod.

## Why fresh user

A real winback flow has three failure modes that only surface with a
brand-new user:

1. **The signed-in gate** — winback fires only when `signedIn=true`.
   An already-subscribed user (you) won't paywall.
2. **The cookie state** — `askmai_winback_offered=1` is set on first
   show; an already-visited browser won't re-offer.
3. **Stripe Checkout coupon line item** — the discount needs to render
   in the Stripe-hosted UI as a line item, not just exist in the
   session metadata.

Each step below has a confirm-point so a failure surfaces at the
exact stage it happened.

## Setup (~3 minutes)

### A. Pick a fresh email

Use a Gmail `+alias` so the magic-link still routes to your inbox but
the Supabase `users` row is a new record:

```
jd.methfessel+winback1@gmail.com
```

(Add `+winback2`, `+winback3` etc. for re-tests since the cookie + the
row will both persist after the first run.)

### B. Open a fresh incognito window

Safari incognito or Chrome incognito with no extensions. **Do not**
reuse a window that's hit `localhost:3000` before — the
`askmai_winback_offered` cookie persists across sessions in the same
profile.

### C. Confirm Stripe is in live mode

`scripts/stripe-create-winback-coupon.mjs` will report
`"livemode": true` on its no-op re-run. The coupon must be live so
real Checkout sessions can attach it.

## The test (≈ 8 minutes including 1 magic-link round-trip)

### Step 1. Land on the creator page

Open `http://localhost:3000/madisonwaller` in the incognito window.

**Confirm:** page renders with the chat shell. Sign-in button visible
in the nav. NO Basic Auth prompt (auth was removed in `f038bc9`).

### Step 2. Burn the 3 free questions

Send these three chats in order so we're sure the cap fires
deterministically:

1. `what should I wear to a fall wedding`
2. `everyday basics under $100`
3. `a beach outfit, anything`

**Confirm:**
- All three return prose + a board (no errors).
- After the 3rd response, the next message would trigger the paywall.
  Don't send a 4th yet — first observe the cap counter.

(Optional sanity: in another terminal, `node --env-file=.env.local -e
"const sb = createClient(...); sb.from('usage_counters').select(...)
.eq('device_id', '<cookie value>').single().then(...)"` would show
`free_uses_count: 3`.)

### Step 3. Trigger the paywall

Send a 4th message: `what's your beauty routine`

**Confirm:**
- The chat response does NOT render.
- The paywall modal opens with the "You've used your free stylings"
  headline.
- Because this is a fresh visitor, the sign-in form is shown (not the
  plan picker). Email input is the first field.

### Step 4. Sign in via magic link

Enter `jd.methfessel+winback1@gmail.com`. Click "Send sign-in link".
Open the email; click the magic link.

**Confirm:**
- Email arrives within ~10s. Subject is something like "Confirm your
  signup".
- Magic-link click bounces back to localhost:3000/madisonwaller.
- Paywall modal re-opens, but this time the **plan picker** is shown
  (Monthly $9.99/mo + Annual $29.99/yr).

This is the moment the winback intercept arms — `signedIn=true` and
the cookie hasn't been set yet.

### Step 5. Trigger exit-intent

Click the **X** in the top-right of the paywall modal. (Or click the
dark backdrop outside the card. Either should work.)

**Confirm:**
- The plan picker disappears.
- A **new modal** swaps in with:
  - Eyebrow: `ONE MORE THING` (gold, small caps)
  - H2: `Stay for a minute.` (serif)
  - Body: `50% off your first 3 months. Same access, half the
    price — that's it.`
  - Primary button: `Continue at 50% off →` (accent-colored)
  - Secondary link: `Not today` (muted, beneath the primary)
  - Modal looks like a polished variant of the paywall, NOT a
    different visual style.

If you instead see the paywall close completely without a second
modal, the intercept didn't fire. Check browser dev-tools console for
errors. Most likely cause: `winbackAvailable` came back false from
the cookie check on mount (someone already saw it on this browser).

### Step 6. Verify the cookie was set

In dev-tools → Application → Cookies → `localhost`:

**Confirm:**
- `askmai_winback_offered=1` is present.
- `Max-Age` ≈ 1 year (31536000 seconds).
- `SameSite=Lax`, `Path=/`.

The cookie writes the **moment** the winback opens, not when the user
accepts. So even if they dismiss with X, the offer is consumed.

### Step 7. Click "Continue at 50% off →"

**Confirm:**
- Button label changes briefly to "One moment…" while POST
  `/api/checkout` is in flight.
- Browser redirects to `checkout.stripe.com/c/pay/cs_live_...`.
- The Stripe-hosted checkout page renders.

If instead you see an error message in the modal, check the dev-tools
network tab → `/api/checkout` response. Most likely cause:
`STRIPE_WINBACK_COUPON_ID` missing from `.env.local` (the route
logs-and-skips and creates a session at full price — but that's not
the failure you're looking at, see step 8).

### Step 8. Verify the DISCOUNT renders in Stripe Checkout

On the Stripe Checkout page, look at the "Order summary" panel:

**Confirm:**
- Line item: AskMai Monthly subscription **$9.99/month** (full
  monthly price, NOT $4.99 — Stripe shows the unit price)
- A **discount line** beneath it: `AskMai winback: 50% off 3
  months -$5.00` (or similar wording — Stripe formats this from the
  coupon name + percent_off)
- Total today: $4.99 (or $4.99 after the discount line resolves)
- A note that says something like "After 3 months, $9.99/month"
  indicating the discount is repeating-for-3-months, not forever.

**Do not actually complete checkout.** The test is the surfaces, not
the charge. Close the tab.

### Step 9. Re-test dismiss behavior

Go back to localhost:3000/madisonwaller. Trigger the paywall again
(send another message — wait, you already burned the cap; just close
and reopen the paywall by dismissing the chat and re-asking).

Actually simpler: clear the chat by reloading the page, but DO NOT
clear cookies. Send one more message → paywall fires → dismiss.

**Confirm:**
- Paywall closes immediately. Winback modal does NOT re-show. (The
  cookie set in step 6 gates re-show.)

This is the "shown once per device" guarantee firing.

## What to do if anything in steps 5–8 fails

- **Modal doesn't swap in step 5**: check `signedIn` is true, check
  cookie wasn't pre-set. Open dev-tools console; my code logs
  `[winback]` lines if I added them (I didn't, but adding 2 console
  lines is a 1-min fix before re-running).
- **Cookie missing in step 6**: race condition where the modal
  rendered but the document.cookie write was blocked. Likely a stale
  closure bug.
- **No coupon line in step 8**: either `STRIPE_WINBACK_COUPON_ID` env
  isn't loaded by the dev server (restart dev) or the coupon ID is
  wrong on Stripe (re-run `scripts/stripe-create-winback-coupon.mjs`
  to confirm).

## After the test

If all 9 steps pass:

1. Commit Chat.tsx + checkout/route.ts + the script.
2. Push to a branch.
3. Set `STRIPE_WINBACK_COUPON_ID=paywall_winback_50` in Vercel env
   (Production + Preview + Development).
4. Merge to main (or push directly per your usual flow).
5. Post-deploy: hit `/api/checkout` with `{coupon:"winback"}` payload
   from CLI to confirm the route accepts it in prod (response should
   have a checkout session URL).

If any step fails, the fix is in the local code — iterate before
pushing.

## Files involved (for reference)

- `src/app/[slug]/Chat.tsx` — PaywallModal exit-intent + WinbackModal
- `src/app/api/checkout/route.ts` — coupon param + discounts attach
- `scripts/stripe-create-winback-coupon.mjs` — coupon bootstrap
- Cookie name: `askmai_winback_offered=1`
- Stripe coupon ID: `paywall_winback_50` (50% off, 3 months
  repeating)
- Env required: `STRIPE_WINBACK_COUPON_ID` (logs-and-skips if missing)
