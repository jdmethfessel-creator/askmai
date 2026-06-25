/**
 * Creator-application lead capture.
 *
 * POST a single application from /creator-signup. Two side effects:
 *   1) insert the row into creator_applications (Supabase)
 *   2) email the founder via Resend so new interest gets noticed
 *      without polling the dashboard.
 *
 * This is intentionally not a self-serve onboarding endpoint — no
 * Supabase Auth row is created, no creators row is provisioned, no
 * twin is materialized. The founder manually promotes approved
 * applications via the dashboard or a seed script.
 */

import { Resend } from "resend";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Payload = {
  name?: string;
  email?: string;
  shopmy_url?: string;
  ltk_url?: string;
  ig_handle?: string;
  tiktok_handle?: string;
  note?: string;
};

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function cleanRequired(v: unknown, max = 200): string | null {
  const c = clean(v);
  if (!c) return null;
  return c.length > max ? c.slice(0, max) : c;
}

export async function POST(request: Request) {
  let body: Payload;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const name = cleanRequired(body.name, 120);
  const email = cleanRequired(body.email, 200)?.toLowerCase() ?? null;
  if (!name) return Response.json({ error: "missing_name" }, { status: 400 });
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "invalid_email" }, { status: 400 });
  }

  // Soft-validate URLs but accept handles too (creators usually paste
  // a handle, not a full URL). Trim to a sensible length; the form
  // already has client-side maxLength.
  const shopmy_url = cleanRequired(body.shopmy_url, 400);
  const ltk_url = cleanRequired(body.ltk_url, 400);
  const ig_handle = cleanRequired(body.ig_handle, 120);
  const tiktok_handle = cleanRequired(body.tiktok_handle, 120);
  const note = cleanRequired(body.note, 1200);

  // At least ONE of (shopmy, ltk, ig, tiktok) so we have something
  // to follow up against. Pure email + name isn't enough to evaluate.
  if (!shopmy_url && !ltk_url && !ig_handle && !tiktok_handle) {
    return Response.json(
      { error: "missing_profile_signal" },
      { status: 400 }
    );
  }

  // 1) Insert. Service-role bypass means RLS doesn't need a per-row
  //    policy for the anonymous submission case.
  const sb = supabaseAdmin();
  const ins = await sb
    .from("creator_applications")
    .insert({
      name,
      email,
      shopmy_url,
      ltk_url,
      ig_handle,
      tiktok_handle,
      note,
    })
    .select("id")
    .single();
  if (ins.error) {
    console.error("[creator-application] insert failed:", ins.error.message);
    return Response.json({ error: "store_failed" }, { status: 500 });
  }

  // 2) Notify the founder. Resend failures don't fail the request —
  //    the row is already saved and we'd rather lose the email than
  //    drop a real applicant on the floor.
  try {
    await sendFounderNotification({
      id: ins.data.id as string,
      name,
      email,
      shopmy_url,
      ltk_url,
      ig_handle,
      tiktok_handle,
      note,
    });
  } catch (err) {
    console.error(
      "[creator-application] founder notification failed:",
      err instanceof Error ? err.message : String(err)
    );
  }

  return Response.json({ ok: true, id: ins.data.id });
}

async function sendFounderNotification(app: {
  id: string;
  name: string;
  email: string;
  shopmy_url: string | null;
  ltk_url: string | null;
  ig_handle: string | null;
  tiktok_handle: string | null;
  note: string | null;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.APPLICATIONS_TO_EMAIL;
  if (!apiKey) {
    console.warn(
      "[creator-application] RESEND_API_KEY not set — skipping notification"
    );
    return;
  }
  if (!to) {
    console.warn(
      "[creator-application] APPLICATIONS_TO_EMAIL not set — skipping notification"
    );
    return;
  }
  // Default to Resend's sandbox sender so the route works without a
  // verified domain on day one. Replace with apply@askmai.co (or
  // similar) once DNS is verified in the Resend dashboard.
  const from =
    process.env.APPLICATIONS_FROM_EMAIL ?? "onboarding@resend.dev";

  const rows: [string, string][] = [
    ["Name", app.name],
    ["Email", app.email],
    ["ShopMy", app.shopmy_url ?? "—"],
    ["LTK", app.ltk_url ?? "—"],
    ["Instagram", app.ig_handle ?? "—"],
    ["TikTok", app.tiktok_handle ?? "—"],
    ["Note", app.note ?? "—"],
    ["Application id", app.id],
  ];

  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const html =
    `<table style="font-family:ui-sans-serif,system-ui,sans-serif;` +
    `font-size:14px;line-height:1.55;color:#1a1610;border-collapse:collapse">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 12px 6px 0;color:#7a6e5d;` +
          `vertical-align:top;white-space:nowrap"><b>${escapeHtml(k)}</b></td>` +
          `<td style="padding:6px 0">${escapeHtml(v)}</td></tr>`
      )
      .join("") +
    `</table>`;

  const resend = new Resend(apiKey);
  await resend.emails.send({
    from,
    to,
    subject: `New creator application: ${app.name}`,
    replyTo: app.email,
    text,
    html,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
