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
 *                                          Then (separately) runs the
 *                                          referral credit + Tier 2
 *                                          coupon logic.
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
 *
 * REFERRAL ARCHITECTURE (only fires on checkout.session.completed):
 *
 *   The subscription activation .update() runs FIRST and is awaited to
 *   completion before any referral RPC is touched. The referral block
 *   is wrapped in its own try/catch so an RPC error, a Stripe coupon
 *   error, a missing env var, or any other downstream issue cannot
 *   undo the activation — the user always leaves the paywall.
 *
 *   Two independent referral branches run on the same event:
 *     (a) maybeCreditAndReward — this user was referred; credit the
 *         inviter's successful_referrals counter and, if the inviter
 *         qualifies (count>=3, not yet rewarded, currently subscribed),
 *         attach the 50%-off coupon to the inviter's sub.
 *     (b) maybeApplyParkedReward — this user is themselves an inviter
 *         whose reward was parked because they weren't subscribed when
 *         their 3rd referral landed. Their first paid subscription is
 *         when the coupon attaches.
 *
 *   Both branches are idempotent under webhook re-delivery:
 *     - credit_referral_subscription guards on referral_credited_at
 *       (per referred user).
 *     - mark_referral_reward_applied guards on referral_reward_applied
 *       (per inviter).
 *     - Stripe's discounts:[{coupon}] update is a replace, so re-
 *       attaching the same coupon is a no-op.
 */

import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFERRAL_THRESHOLD = 3;

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

type SupabaseAdminClient = ReturnType<typeof supabaseAdmin>;

/**
 * Tier 2 credit + coupon attach for the inviter when this user (the
 * referred one) becomes active.
 *
 * Calls credit_referral_subscription RPC which atomically:
 *   (i) claims referral_credited_at on the referred user, returning
 *       early if already credited (idempotent on re-delivery)
 *   (ii) increments inviter.successful_referrals
 *   (iii) returns inviter context (sub_id, sub_status, reward latch)
 *
 * If the inviter qualifies, hands off to applyReward. If not — either
 * count<3, latch already set, inviter not subscribed, inviter has no
 * stripe_subscription_id — silently no-ops. The "inviter not subscribed
 * yet" case is the parked-reward path; it gets picked up in
 * maybeApplyParkedReward on the inviter's own future checkout.
 */
async function maybeCreditAndReward(
  stripe: Stripe,
  sb: SupabaseAdminClient,
  referredUserId: string
): Promise<void> {
  const credit = await sb.rpc("credit_referral_subscription", {
    p_referred_user_id: referredUserId,
  });
  if (credit.error) {
    console.error(
      "[referral] credit_referral_subscription RPC failed:",
      credit.error.message
    );
    return;
  }
  const row = Array.isArray(credit.data) ? credit.data[0] : credit.data;
  if (!row || !row.credited) {
    return;
  }
  const inviterId = row.inviter_id as string;
  const count = row.inviter_successful_referrals as number;
  const rewardApplied = row.inviter_referral_reward_applied as boolean;
  const inviterStatus = row.inviter_subscription_status as string | null;
  const inviterSubId = row.inviter_stripe_subscription_id as string | null;
  console.log(
    `[referral] credited inviter=${inviterId} count=${count}/${REFERRAL_THRESHOLD}`
  );

  if (count < REFERRAL_THRESHOLD || rewardApplied) {
    return;
  }
  if (inviterStatus !== "active" || !inviterSubId) {
    // Parked — inviter isn't currently subscribed. The latch stays
    // false; the coupon will fire when they next subscribe via
    // maybeApplyParkedReward on their own checkout.session.completed.
    console.log(
      `[referral] PARKED for inviter=${inviterId} (status=${inviterStatus}, sub=${inviterSubId ?? "none"})`
    );
    return;
  }
  await applyReward(stripe, sb, inviterId, inviterSubId);
}

/**
 * Picks up an inviter who has a parked reward (>=3 successful
 * referrals but not-yet-applied) the moment they subscribe. Runs on
 * every checkout.session.completed for any user — it's cheap (one row
 * read) and is the path that makes "park-and-apply" work end-to-end.
 *
 * If the user has fewer than 3 referrals or the latch is already set,
 * this is a no-op. If they qualify, the coupon attaches to the sub we
 * just created.
 */
async function maybeApplyParkedReward(
  stripe: Stripe,
  sb: SupabaseAdminClient,
  userId: string,
  subscriptionId: string
): Promise<void> {
  const row = await sb
    .from("users")
    .select("successful_referrals, referral_reward_applied")
    .eq("id", userId)
    .maybeSingle();
  if (row.error || !row.data) return;
  const count = (row.data.successful_referrals ?? 0) as number;
  const rewardApplied = (row.data.referral_reward_applied ?? false) as boolean;
  if (count < REFERRAL_THRESHOLD || rewardApplied) {
    return;
  }
  console.log(
    `[referral] applying PARKED reward to user=${userId} (successful_referrals=${count})`
  );
  await applyReward(stripe, sb, userId, subscriptionId);
}

/**
 * Attaches the configured 50%-off coupon to a subscription and, only
 * on Stripe-side success, latches referral_reward_applied so the
 * reward never fires twice. Latch failure after Stripe success is OK:
 * a future re-attach of the same coupon is a no-op because
 * stripe.subscriptions.update({ discounts: [{coupon}] }) is a replace.
 *
 * STRIPE_REFERRAL_COUPON_ID env var must be set. Missing → log + skip
 * (latch stays false, retries on the next eligible event once env is
 * fixed). Stripe-side error → log + skip + leave latch false (retries
 * on the next eligible event).
 */
async function applyReward(
  stripe: Stripe,
  sb: SupabaseAdminClient,
  inviterId: string,
  subId: string
): Promise<void> {
  const couponId = process.env.STRIPE_REFERRAL_COUPON_ID;
  if (!couponId) {
    console.error(
      "[referral] STRIPE_REFERRAL_COUPON_ID not set — reward NOT applied. " +
        "Set env var and the next eligible event will retry."
    );
    return;
  }
  try {
    await stripe.subscriptions.update(subId, {
      discounts: [{ coupon: couponId }],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[referral] coupon attach failed inviter=${inviterId} sub=${subId}:`,
      msg
    );
    return;
  }
  const latch = await sb.rpc("mark_referral_reward_applied", {
    p_inviter_id: inviterId,
  });
  if (latch.error) {
    console.error(
      "[referral] mark_referral_reward_applied RPC failed (latch not set, will re-attempt next eligible event):",
      latch.error.message
    );
    return;
  }
  if (latch.data) {
    console.log(
      `[referral] REWARD APPLIED inviter=${inviterId} sub=${subId} coupon=${couponId}`
    );
  }
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

        // ====================================================
        // STEP 1: SUBSCRIPTION ACTIVATION
        // This is the original, unchanged write that flips the
        // user past the paywall. Must complete before anything
        // referral-related runs.
        // ====================================================
        await sb
          .from("users")
          .update({
            subscription_status: "active",
            plan,
            stripe_customer_id: customerId,
            stripe_subscription_id: subscriptionId,
          })
          .eq("id", userId);

        // ====================================================
        // STEP 2: REFERRAL LOGIC (FULLY ISOLATED)
        // Wrapped in its own try/catch — any failure here logs
        // and the handler returns 200 anyway, so Stripe doesn't
        // retry just because the referral side errored.
        // Independent of the activation above.
        // ====================================================
        try {
          await maybeCreditAndReward(stripe, sb, userId);
          await maybeApplyParkedReward(stripe, sb, userId, subscriptionId);
        } catch (err) {
          console.error("[stripe-webhook] referral block error:", err);
        }
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
        // No referral logic on updates: per the spec, only the
        // checkout.session.completed conversion event counts as a
        // successful referral. Renewals, plan changes, and trial
        // transitions do not re-credit.
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
        // No referral reversal on cancellation. A credited referral
        // stays credited; the inviter's reward (if already applied)
        // stays applied. This matches "rewards never trigger from the
        // inviter sending or generating a link, only from a real
        // distinct other person acting" — the action happened, the
        // credit stands.
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
