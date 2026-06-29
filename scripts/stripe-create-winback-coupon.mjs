/**
 * One-off: ensure the paywall winback coupon exists in Stripe.
 *
 * Mirrors stripe-create-referral-coupon.mjs in shape and pattern. The
 * winback coupon is applied at /api/checkout when a user accepts the
 * exit-intent discount offer on the paywall — it's pre-created once
 * here, never minted ad-hoc per user.
 *
 * Properties (matching the spec):
 *   id                 paywall_winback_50    (custom, deterministic — lets
 *                                            this script be idempotent)
 *   percent_off        50
 *   duration           repeating
 *   duration_in_months 3                     (caps downside; same shape
 *                                            as the referral coupon, NOT
 *                                            forever, per spec)
 *
 * Idempotency: stripe.coupons.retrieve() is attempted first. If the
 * coupon already exists at that ID with matching properties, we
 * report it and exit 0 without creating a duplicate. Property
 * mismatch on an existing coupon errors loud — Stripe coupon fields
 * are immutable, so the only fix is to rename COUPON_ID here and
 * re-run.
 *
 * Safe to re-run. The coupon ID printed at the end is the value that
 * must go into STRIPE_WINBACK_COUPON_ID in Vercel env (Production +
 * Preview + Development) AND in local .env.local.
 *
 * Run with:  node --env-file=.env.local scripts/stripe-create-winback-coupon.mjs
 */

import Stripe from "stripe";

const COUPON_ID = "paywall_winback_50";
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
    name: "AskMai winback: 50% off 3 months",
  });
  console.log("Coupon created.");
  console.log(JSON.stringify(describe(created), null, 2));
  return created;
}

const c = await ensureCoupon();

console.log("");
console.log("ENV VAR TO SET ON VERCEL + LOCAL .env.local:");
console.log(`  STRIPE_WINBACK_COUPON_ID=${c.id}`);
