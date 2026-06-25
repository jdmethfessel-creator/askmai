#!/usr/bin/env node
/**
 * One-off: provision the AskMai Premium product + two prices in Stripe.
 *
 * Idempotent — reuses an existing product with the same name and an
 * existing price with matching amount/currency/interval, so re-runs are
 * safe and won't create duplicates.
 *
 * Run with: node --env-file=.env.local scripts/stripe-setup.mjs
 */

import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("STRIPE_SECRET_KEY is not set. Aborting.");
  process.exit(1);
}

const mode = key.startsWith("sk_live_")
  ? "live"
  : key.startsWith("sk_test_")
  ? "test"
  : "unknown";

if (mode === "unknown") {
  console.error(
    `Unrecognized STRIPE_SECRET_KEY prefix. Expected sk_test_ or sk_live_; refusing to run.`
  );
  process.exit(1);
}

console.log(`Stripe mode: ${mode}\n`);

const stripe = new Stripe(key);

const PRODUCT_NAME = "AskMai Premium";
const PRODUCT_DESCRIPTION =
  "Unlimited conversations with every AskMai creator twin.";

// ----- product (idempotent) -----------------------------------------
let product;
const search = await stripe.products.search({
  query: `name:"${PRODUCT_NAME}" AND active:"true"`,
});
if (search.data.length > 0) {
  product = search.data[0];
  console.log(`Reusing existing product: ${product.id}`);
} else {
  product = await stripe.products.create({
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
  });
  console.log(`Created product: ${product.id}`);
}

// ----- prices (idempotent) ------------------------------------------
async function ensurePrice({ amount, interval, label }) {
  const list = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  const match = list.data.find(
    (p) =>
      p.unit_amount === amount &&
      p.currency === "usd" &&
      p.recurring?.interval === interval
  );
  if (match) {
    console.log(`Reusing ${label} price: ${match.id}`);
    return match;
  }
  const created = await stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency: "usd",
    recurring: { interval },
  });
  console.log(`Created ${label} price: ${created.id}`);
  return created;
}

const monthly = await ensurePrice({
  amount: 999,
  interval: "month",
  label: "monthly",
});
const yearly = await ensurePrice({
  amount: 2999,
  interval: "year",
  label: "annual",
});

console.log("");
console.log("=== AskMai Stripe catalog ===");
console.log(`mode:           ${mode}`);
console.log(`product:        ${product.id}`);
console.log(`monthly price:  ${monthly.id}    $9.99/month`);
console.log(`annual price:   ${yearly.id}    $29.99/year`);
console.log("");
console.log(
  "Next: store the two price IDs in env (e.g. STRIPE_PRICE_MONTHLY, " +
    "STRIPE_PRICE_ANNUAL) — the checkout phase will reference them."
);
