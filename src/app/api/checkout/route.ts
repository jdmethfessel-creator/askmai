/**
 * Stripe Checkout Session creator.
 *
 * POST { plan: "monthly" | "annual", returnTo?: string }
 *
 * Requires an authenticated session (magic-link signed in). Returns 401
 * when anonymous — the paywall modal uses that signal to swap to the
 * sign-in form before re-trying.
 *
 * Maps the session back to the user via:
 *   client_reference_id  = our users.id (read in the webhook to update
 *                          subscription_status / stripe_customer_id /
 *                          stripe_subscription_id)
 *   customer_email       = user.email (prefills Checkout, helps Stripe
 *                          dedupe customers)
 *
 * success_url / cancel_url bring the visitor back to the creator page
 * they came from. The `subscribed` query param is purely cosmetic — the
 * source of truth for "are they subscribed" is users.subscription_status,
 * set by the webhook.
 */

import Stripe from "stripe";
import { getServerSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  let body: { plan?: string; returnTo?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const plan = body.plan;
  if (plan !== "monthly" && plan !== "annual") {
    return Response.json({ error: "invalid_plan" }, { status: 400 });
  }

  const priceId =
    plan === "monthly"
      ? process.env.STRIPE_PRICE_MONTHLY
      : process.env.STRIPE_PRICE_ANNUAL;
  if (!priceId) {
    console.error(`[checkout] STRIPE_PRICE_${plan.toUpperCase()} not set`);
    return Response.json({ error: "price_not_configured" }, { status: 500 });
  }

  // Only accept relative paths for returnTo so we can't be turned into
  // an open redirector against a third-party host.
  const safeReturnTo =
    typeof body.returnTo === "string" && body.returnTo.startsWith("/")
      ? body.returnTo
      : "/";
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? new URL(request.url).origin;

  const stripe = new Stripe(secretKey);
  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: session.userId,
    customer_email: session.email,
    success_url: `${siteUrl}${safeReturnTo}?subscribed=1`,
    cancel_url: `${siteUrl}${safeReturnTo}?subscribed=0`,
    allow_promotion_codes: true,
  });

  if (!checkoutSession.url) {
    console.error("[checkout] stripe returned a session with no url");
    return Response.json({ error: "no_session_url" }, { status: 500 });
  }

  return Response.json({ url: checkoutSession.url });
}
