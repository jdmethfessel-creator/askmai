/**
 * Stripe Checkout Session creator.
 *
 * TWO MODES:
 *
 *   Subscription mode (existing, unchanged behavior):
 *     POST { plan: "monthly" | "annual", returnTo?: string,
 *            coupon?: "winback" }
 *     Creates a `mode: "subscription"` session against
 *     STRIPE_PRICE_MONTHLY / STRIPE_PRICE_ANNUAL.
 *
 *   Pack mode (Phase 2 add-on, one-time, non-expiring credits):
 *     POST { pack: "pack_20" | "pack_50", returnTo?: string }
 *     Creates a `mode: "payment"` session against
 *     STRIPE_PRICE_PACK_20 / STRIPE_PRICE_PACK_50. Fulfillment lives
 *     in the stripe webhook and is isolated from subscription
 *     activation: a pack purchase never flips subscription_status.
 *
 * Requires an authenticated session (magic-link signed in). Returns 401
 * when anonymous — the paywall modal uses that signal to swap to the
 * sign-in form before re-trying.
 *
 * Maps the session back to the user via:
 *   client_reference_id  = our users.id (read in the webhook to update
 *                          subscription_status / stripe_customer_id /
 *                          stripe_subscription_id, OR — in pack mode —
 *                          to credit pack_render_balance)
 *   customer_email       = user.email (prefills Checkout, helps Stripe
 *                          dedupe customers)
 *   metadata.kind        = 'subscription' | 'pack'
 *   metadata.pack_id     = 'pack_20' | 'pack_50' (pack mode only)
 *
 * coupon=="winback" is the paywall exit-intent 50%-off path. When
 * present, the resolved Stripe coupon ID comes from
 * STRIPE_WINBACK_COUPON_ID env (see scripts/stripe-create-winback-
 * coupon.mjs for the canonical id `paywall_winback_50`). If the env
 * var is missing the request still creates a working checkout
 * session at full price — we log loud and continue rather than break
 * checkout over a misconfigured deploy. Only `winback` is accepted
 * here; arbitrary user-supplied coupon strings are ignored so a
 * tampered request can't smuggle in a different discount. Packs
 * never accept a coupon (priced flat).
 *
 * success_url / cancel_url bring the visitor back to the page they
 * came from. The `subscribed=1` / `pack=1` query params are purely
 * cosmetic — the source of truth for subscription_status and
 * pack_render_balance is the webhook.
 */

import Stripe from "stripe";
import { getServerSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PackId = "pack_20" | "pack_50";

const PACK_PRICE_ENV: Record<PackId, string> = {
  pack_20: "STRIPE_PRICE_PACK_20",
  pack_50: "STRIPE_PRICE_PACK_50",
};

export async function POST(request: Request) {
  const session = await getServerSession();
  if (!session) {
    return Response.json({ error: "not_signed_in" }, { status: 401 });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error("[checkout] STRIPE_SECRET_KEY not set");
    return Response.json({ error: "stripe_not_configured" }, { status: 500 });
  }

  let body: {
    plan?: string;
    pack?: string;
    returnTo?: string;
    coupon?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const stripe = new Stripe(secretKey);

  const safeReturnTo =
    typeof body.returnTo === "string" && body.returnTo.startsWith("/")
      ? body.returnTo
      : "/";
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;

  // ----- Pack mode ---------------------------------------------------
  // One-time payment, no coupon path. Pack metadata is the only thing
  // the webhook reads to decide between subscription activation vs
  // pack-balance credit.
  if (body.pack === "pack_20" || body.pack === "pack_50") {
    const pack = body.pack as PackId;
    const envName = PACK_PRICE_ENV[pack];
    const priceId = process.env[envName];
    if (!priceId) {
      console.error(`[checkout] ${envName} not set`);
      return Response.json(
        { error: "price_not_configured" },
        { status: 500 }
      );
    }
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: session.userId,
      customer_email: session.email,
      success_url: `${siteUrl}${safeReturnTo}?pack=1`,
      cancel_url: `${siteUrl}${safeReturnTo}?pack=0`,
      payment_intent_data: {
        metadata: {
          kind: "pack",
          pack_id: pack,
          user_id: session.userId,
        },
      },
      metadata: {
        kind: "pack",
        pack_id: pack,
        user_id: session.userId,
      },
    });
    if (!checkoutSession.url) {
      console.error("[checkout] stripe returned a pack session with no url");
      return Response.json({ error: "no_session_url" }, { status: 500 });
    }
    return Response.json({ url: checkoutSession.url });
  }

  // ----- Subscription mode (existing behavior) -----------------------
  const plan = body.plan;
  if (plan !== "monthly" && plan !== "annual") {
    return Response.json({ error: "invalid_plan" }, { status: 400 });
  }

  // Coupon resolution: only the literal string "winback" is honored
  // here, and it resolves to STRIPE_WINBACK_COUPON_ID server-side. Any
  // other value (or a missing env) means no discount is applied, but
  // checkout still proceeds at full price — never break the payment
  // flow over a misconfigured coupon.
  let resolvedCouponId: string | null = null;
  if (body.coupon === "winback") {
    const couponId = process.env.STRIPE_WINBACK_COUPON_ID;
    if (couponId) {
      resolvedCouponId = couponId;
    } else {
      console.error(
        "[checkout] STRIPE_WINBACK_COUPON_ID not set — winback request will proceed at full price. Set env var on Vercel + locally."
      );
    }
  }

  const priceId =
    plan === "monthly"
      ? process.env.STRIPE_PRICE_MONTHLY
      : process.env.STRIPE_PRICE_ANNUAL;
  if (!priceId) {
    console.error(`[checkout] STRIPE_PRICE_${plan.toUpperCase()} not set`);
    return Response.json({ error: "price_not_configured" }, { status: 500 });
  }

  // discounts and allow_promotion_codes are mutually exclusive in
  // Stripe Checkout. When a server-side coupon is being applied (the
  // winback path), we drop the promo-code field so the discount UI
  // doesn't show two competing places to enter a code; the discount
  // is locked to what the server set.
  const baseParams: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: session.userId,
    customer_email: session.email,
    success_url: `${siteUrl}${safeReturnTo}?subscribed=1`,
    cancel_url: `${siteUrl}${safeReturnTo}?subscribed=0`,
    metadata: {
      kind: "subscription",
      user_id: session.userId,
    },
  };
  if (resolvedCouponId) {
    baseParams.discounts = [{ coupon: resolvedCouponId }];
  } else {
    baseParams.allow_promotion_codes = true;
  }
  const checkoutSession = await stripe.checkout.sessions.create(baseParams);

  if (!checkoutSession.url) {
    console.error("[checkout] stripe returned a session with no url");
    return Response.json({ error: "no_session_url" }, { status: 500 });
  }

  return Response.json({ url: checkoutSession.url });
}
