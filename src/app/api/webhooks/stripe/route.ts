/**
 * Stripe webhook receiver.
 *
 * Verifies the signature using STRIPE_WEBHOOK_SECRET — the route fails
 * loud (500) when that env var is missing so a misconfigured deploy is
 * immediately visible in Stripe's webhook delivery log rather than
 * silently letting events through unverified.
 *
 * Handles three event types:
 *
 *   checkout.session.completed          → first subscription. Maps
 *                                          client_reference_id (our
 *                                          users.id) to the Stripe
 *                                          customer + subscription IDs
 *                                          and flips
 *                                          subscription_status='active'.
 *
 *   customer.subscription.updated       → renewals, plan changes, pause
 *                                          / resume. Mirrors the
 *                                          Stripe status onto our
 *                                          enum.
 *
 *   customer.subscription.deleted       → terminal cancellation. Sets
 *                                          subscription_status='canceled'.
 *
 * All other events return 200 quickly so Stripe doesn't retry them.
 */

import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function planFromInterval(
  interval: Stripe.Price.Recurring["interval"] | undefined
): "monthly" | "annual" | null {
  if (interval === "year") return "annual";
  if (interval === "month") return "monthly";
  return null;
}

function statusFromStripe(s: Stripe.Subscription.Status): "active" | "canceled" | "none" {
  if (s === "active" || s === "trialing") return "active";
  if (s === "canceled") return "canceled";
  return "none";
}

export async function POST(request: Request) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey) {
    console.error("[stripe-webhook] STRIPE_SECRET_KEY not set, rejecting");
    return new Response("server_not_configured", { status: 500 });
  }
  if (!webhookSecret) {
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET not set, rejecting");
    return new Response("webhook_not_configured", { status: 500 });
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("missing_signature", { status: 400 });

  // constructEvent requires the raw bytes exactly as Stripe sent them.
  const rawBody = await request.text();
  const stripe = new Stripe(secretKey);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[stripe-webhook] signature verify failed:", msg);
    return new Response(`signature_error: ${msg}`, { status: 400 });
  }

  const sb = supabaseAdmin();

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const userId = s.client_reference_id;
        const customerId =
          typeof s.customer === "string" ? s.customer : s.customer?.id;
        const subscriptionId =
          typeof s.subscription === "string"
            ? s.subscription
            : s.subscription?.id;
        if (!userId || !customerId || !subscriptionId) {
          console.warn(
            "[stripe-webhook] checkout.session.completed missing mapping fields",
            { userId, customerId, subscriptionId }
          );
          break;
        }
        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const interval = sub.items.data[0]?.price?.recurring?.interval;
        const plan = planFromInterval(interval);
        await sb
          .from("users")
          .update({
            subscription_status: "active",
            plan,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
          })
          .eq("id", userId);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const status = statusFromStripe(sub.status);
        const interval = sub.items.data[0]?.price?.recurring?.interval;
        const plan = status === "active" ? planFromInterval(interval) : null;
        await sb
          .from("users")
          .update({
            subscription_status: status,
            plan,
            stripe_subscription_id: sub.id,
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const customerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        await sb
          .from("users")
          .update({
            subscription_status: "canceled",
            plan: null,
          })
          .eq("stripe_customer_id", customerId);
        break;
      }

      default:
        // Ignored event type — return 200 so Stripe doesn't retry.
        break;
    }
  } catch (err) {
    console.error("[stripe-webhook] handler error:", err);
    return new Response("handler_error", { status: 500 });
  }

  return new Response("ok", { status: 200 });
}
