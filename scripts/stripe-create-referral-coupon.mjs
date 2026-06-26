/**
 * One-off: ensure the referral reward coupon exists in Stripe.
 *
 * The coupon is the 50%-off reward applied to an inviter's subscription
 * when their 3rd referred user converts to paid. It's pre-created once
 * here, not minted ad-hoc per inviter, so the webhook handler stays
 * fast and the discount is centrally manageable.
 *
 * Properties:
 *   id              referral_50_off_3mo    (custom, deterministic — lets
 *                                          this script be idempotent)
 *   percent_off     50
 *   duration        repeating
 *   duration_in_months 3
 *
 * Idempotency: stripe.coupons.retrieve() is attempted first. If the
 * coupon already exists at that ID, we report it and exit 0 without
 * creating a duplicate. If it doesn't (404 / StripeInvalidRequestError
 * with resource_missing), we create with the explicit id and report.
 *
 * Safe to re-run. The coupon ID printed at the end is the value that
 * must go into STRIPE_REFERRAL_COUPON_ID in Vercel env.
 *
 * Run with:  node --env-file=.env.local scripts/stripe-create-referral-coupon.mjs
 */

import Stripe from "stripe";

const COUPON_ID = "referral_50_off_3mo";
const PERCENT_OFF = 50;
const DURATION = "repeating";
const DURATION_IN_MONTHS = 3;

const secret = process.env.STRIPE_SECRET_KEY;
if (!secret) {
  console.error("STRIPE_SECRET_KEY is not set in env.");
  process.exit(1);
}
const stripe = new Stripe(secret);

function describe(c) {
  return {
    id: c.id,
    percent_off: c.percent_off,
    duration: c.duration,
    duration_in_months: c.duration_in_months,
    valid: c.valid,
    livemode: c.livemode,
    created: new Date(c.created * 1000).toISOString(),
  };
}

async function ensureCoupon() {
  let existing = null;
  try {
    existing = await stripe.coupons.retrieve(COUPON_ID);
  } catch (err) {
    if (err?.code !== "resource_missing") {
      console.error("Unexpected error retrieving coupon:", err.message);
      process.exit(1);
    }
  }

  if (existing) {
    // Verify the properties match what the webhook expects. If they
    // drift (e.g. someone edited the coupon in the dashboard), we
    // surface that — Stripe coupons are immutable on these fields, so
    // a mismatch means a new coupon under a different ID is needed.
    const mismatches = [];
    if (existing.percent_off !== PERCENT_OFF) {
      mismatches.push(
        `percent_off=${existing.percent_off} (expected ${PERCENT_OFF})`
      );
    }
    if (existing.duration !== DURATION) {
      mismatches.push(
        `duration=${existing.duration} (expected ${DURATION})`
      );
    }
    if (existing.duration_in_months !== DURATION_IN_MONTHS) {
      mismatches.push(
        `duration_in_months=${existing.duration_in_months} (expected ${DURATION_IN_MONTHS})`
      );
    }
    if (mismatches.length > 0) {
      console.error("Existing coupon has unexpected properties:");
      for (const m of mismatches) console.error("  - " + m);
      console.error(
        "Coupon fields are immutable; rename COUPON_ID in this script and re-run."
      );
      process.exit(1);
    }
    console.log("Coupon already exists. No-op.");
    console.log(JSON.stringify(describe(existing), null, 2));
    return existing;
  }

  const created = await stripe.coupons.create({
    id: COUPON_ID,
    percent_off: PERCENT_OFF,
    duration: DURATION,
    duration_in_months: DURATION_IN_MONTHS,
    name: "AskMai referral: 50% off 3 months",
  });
  console.log("Coupon created.");
  console.log(JSON.stringify(describe(created), null, 2));
  return created;
}

const c = await ensureCoupon();

console.log("");
console.log("ENV VAR TO SET ON VERCEL:");
console.log(`  STRIPE_REFERRAL_COUPON_ID=${c.id}`);
