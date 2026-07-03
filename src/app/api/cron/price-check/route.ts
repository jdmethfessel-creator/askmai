/**
 * GET /api/cron/price-check
 *
 * Daily sale detector. For every product that has an active watch or
 * has a snapshot in the last 30 days:
 *   1. Compare the current creator_products.price to max(snapshots.price)
 *      over the last 30 days.
 *   2. If the drop is >= 15% AND >= $10, mark on_sale=true, set
 *      compare_at_price to the prior max, stamp sale_started_at.
 *   3. Queue alerts to each watch that hasn't received one for the
 *      current sale event.
 *   4. If price recovered (current >= prior max * 0.9 OR on_sale set
 *      but drop no longer qualifies), clear on_sale.
 *
 * Header guard: `x-cron-secret` MUST match process.env.CRON_SECRET.
 *
 * Idempotent-friendly: safe to run multiple times per day. Sending
 * dedup is on sale_alerts_sent (watch_id + latest sent_at within the
 * current sale event).
 *
 * No-ops silently on missing tables so a fresh environment doesn't
 * throw.
 */

import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabase";
import {
  SALE_RULE,
  isSaleDrop,
  maxRecentPrice,
} from "@/lib/sales";
import { renderSaleEmailHtml, renderSaleEmailSubject } from "@/lib/salesEmail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function baseUrl(request: Request): string {
  const envUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    process.env.NEXT_PUBLIC_BASE_URL ??
    process.env.VERCEL_URL;
  if (envUrl) {
    return envUrl.startsWith("http") ? envUrl : `https://${envUrl}`;
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET ?? "";
  const provided =
    request.headers.get("x-cron-secret") ??
    (request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  if (!expected || provided !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = supabaseAdmin();

  let products: Array<{
    id: string;
    creator_id: string;
    product_title: string;
    brand: string | null;
    image_url: string;
    affiliate_url: string;
    price: number | null;
    source_network: string;
    compare_at_price: number | null;
    on_sale: boolean | null;
  }> = [];

  try {
    const since = new Date(
      Date.now() - SALE_RULE.windowDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const watched = await sb
      .from("product_watches")
      .select("product_id")
      .limit(5000);
    const snapshotted = await sb
      .from("price_snapshots")
      .select("product_id")
      .gte("captured_at", since)
      .limit(5000);
    const ids = new Set<string>();
    for (const r of (watched.data as { product_id: string }[] | null) ?? []) {
      ids.add(r.product_id);
    }
    for (const r of (snapshotted.data as { product_id: string }[] | null) ?? []) {
      ids.add(r.product_id);
    }
    if (ids.size === 0) {
      return Response.json({ ok: true, checked: 0, marked_on_sale: 0, alerted: 0 });
    }
    const prod = await sb
      .from("creator_products")
      .select(
        "id, creator_id, product_title, brand, image_url, affiliate_url, price, source_network, compare_at_price, on_sale"
      )
      .in("id", Array.from(ids));
    products = (prod.data as typeof products) ?? [];
  } catch (err) {
    return Response.json(
      {
        ok: false,
        error: "schema_missing",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

  const creatorIds = Array.from(new Set(products.map((p) => p.creator_id)));
  const creatorMap = new Map<string, { first_name: string; slug: string }>();
  if (creatorIds.length > 0) {
    const cr = await sb
      .from("creators")
      .select("id, name, slug")
      .in("id", creatorIds);
    for (const c of (cr.data as { id: string; name: string; slug: string }[] | null) ?? []) {
      creatorMap.set(c.id, {
        first_name: (c.name || "").trim().split(/\s+/)[0] || "the creator",
        slug: c.slug,
      });
    }
  }

  let markedOnSale = 0;
  let cleared = 0;
  let alerted = 0;

  const resendKey = process.env.RESEND_API_KEY ?? "";
  const resend = resendKey ? new Resend(resendKey) : null;
  const fromEmail =
    process.env.APPLICATIONS_FROM_EMAIL ?? "sales@askmai.co";

  for (const p of products) {
    const historical = await maxRecentPrice(sb, p.id);
    if (p.price == null) continue;
    const nowOnSale = isSaleDrop(p.price, historical);

    if (nowOnSale && !p.on_sale) {
      try {
        await sb
          .from("creator_products")
          .update({
            on_sale: true,
            compare_at_price: historical,
            sale_started_at: new Date().toISOString(),
          })
          .eq("id", p.id);
        markedOnSale++;
      } catch {
        /* silent */
      }
    }
    if (!nowOnSale && p.on_sale) {
      try {
        await sb
          .from("creator_products")
          .update({
            on_sale: false,
            compare_at_price: null,
            sale_started_at: null,
          })
          .eq("id", p.id);
        cleared++;
      } catch {
        /* silent */
      }
    }

    if (!nowOnSale) continue;

    // Fan out alerts for this product's watches.
    let watches: Array<{
      id: string;
      user_id: string | null;
      email: string | null;
      token: string;
    }> = [];
    try {
      const { data } = await sb
        .from("product_watches")
        .select("id, user_id, email, token")
        .eq("product_id", p.id);
      watches = (data as typeof watches) ?? [];
    } catch {
      watches = [];
    }
    if (watches.length === 0) continue;

    // Load email addresses for user-id watches.
    const userIds = watches
      .map((w) => w.user_id)
      .filter((x): x is string => Boolean(x));
    const userEmailMap = new Map<string, string>();
    if (userIds.length > 0) {
      const u = await sb.from("users").select("id, email").in("id", userIds);
      for (const row of (u.data as { id: string; email: string }[] | null) ?? []) {
        userEmailMap.set(row.id, row.email);
      }
    }

    const creator = creatorMap.get(p.creator_id) ?? {
      first_name: "the creator",
      slug: "",
    };

    for (const w of watches) {
      const email = w.user_id ? userEmailMap.get(w.user_id) : w.email;
      if (!email) continue;

      // Dedup: skip if we already sent an alert for this watch since
      // the current sale event started.
      try {
        const dedup = await sb
          .from("sale_alerts_sent")
          .select("id")
          .eq("watch_id", w.id)
          .gte("new_price", p.price)
          .limit(1);
        if (Array.isArray(dedup.data) && dedup.data.length > 0) continue;
      } catch {
        /* proceed on lookup failure */
      }

      const oldPrice = historical ?? p.price;
      const html = renderSaleEmailHtml({
        creatorFirstName: creator.first_name,
        creatorSlug: creator.slug,
        productTitle: p.product_title,
        brand: p.brand,
        imageUrl: p.image_url,
        affiliateUrl: p.affiliate_url,
        oldPrice,
        newPrice: p.price,
        network: p.source_network,
        unsubscribeUrl: `${baseUrl(request)}/api/watch/unsubscribe?token=${encodeURIComponent(w.token)}`,
      });
      const subject = renderSaleEmailSubject({
        productTitle: p.product_title,
        newPrice: p.price,
      });

      if (resend) {
        try {
          await resend.emails.send({
            from: fromEmail,
            to: email,
            subject,
            html,
          });
          alerted++;
        } catch (err) {
          console.warn(
            "[cron/price-check] resend send failed:",
            err instanceof Error ? err.message : String(err)
          );
          continue;
        }
      } else {
        console.log(
          `[cron/price-check] would email ${email} for ${p.id} (RESEND_API_KEY not set)`
        );
        alerted++;
      }

      try {
        await sb.from("sale_alerts_sent").insert({
          watch_id: w.id,
          old_price: oldPrice,
          new_price: p.price,
        });
      } catch {
        /* silent */
      }
    }
  }

  return Response.json({
    ok: true,
    checked: products.length,
    marked_on_sale: markedOnSale,
    cleared,
    alerted,
  });
}
