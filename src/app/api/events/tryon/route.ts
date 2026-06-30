/**
 * POST /api/events/tryon
 *
 * Lightweight ingestion endpoint for try-on funnel events fired by
 * the client (TryOnGrid / Chat hooks). Writes one row to
 * public.tryon_events per call. No auth (anonymous fans should be
 * tracked), no third-party SDK, no PII beyond product / creator /
 * session identifiers.
 *
 * Body shape (all fields optional except event):
 *   {
 *     event: 'tryon_start' | 'tryon_complete_ok' | 'tryon_complete_fail',
 *     creatorSlug?: string,
 *     productExternalId?: string,
 *     productSubcategory?: string,
 *     outfitSize?: number,         // 1 for single, N for outfit
 *     durationMs?: number,         // on completion events
 *     failureReason?: string,      // on tryon_complete_fail
 *     sessionId?: string,          // client-generated per page load
 *   }
 *
 * Returns 204 No Content on success (lightweight; the client
 * doesn't await a response body). Failures inside the insert are
 * logged but never block the user-facing UX; events are best-effort
 * telemetry, not gating logic.
 */

import { getServerSession } from "@/lib/session";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const ALLOWED_EVENTS = new Set([
  "tryon_start",
  "tryon_complete_ok",
  "tryon_complete_fail",
]);

type IncomingBody = {
  event?: string;
  creatorSlug?: string;
  productExternalId?: string;
  productSubcategory?: string;
  outfitSize?: number;
  durationMs?: number;
  failureReason?: string;
  sessionId?: string;
};

function clampStr(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, maxLen);
}

function clampInt(v: unknown, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 0) return null;
  if (n > max) return max;
  return n;
}

export async function POST(request: Request) {
  let body: IncomingBody;
  try {
    body = (await request.json()) as IncomingBody;
  } catch {
    return new Response(null, { status: 400 });
  }

  const event = clampStr(body.event, 32);
  if (!event || !ALLOWED_EVENTS.has(event)) {
    return new Response(null, { status: 400 });
  }

  // Optional user_id from session. Unauthenticated visitors get
  // user_id NULL; their session_id is the only correlation key.
  const session = await getServerSession().catch(() => null);
  const userId = session?.userId ?? null;

  const sb = supabaseAdmin();
  const { error } = await sb.from("tryon_events").insert({
    event,
    creator_slug: clampStr(body.creatorSlug, 64),
    product_external_id: clampStr(body.productExternalId, 128),
    product_subcategory: clampStr(body.productSubcategory, 32),
    outfit_size: clampInt(body.outfitSize, 20),
    duration_ms: clampInt(body.durationMs, 600_000),
    failure_reason: clampStr(body.failureReason, 64),
    session_id: clampStr(body.sessionId, 64),
    user_id: userId,
  });

  if (error) {
    // Telemetry should never block the user-facing flow. Log and
    // return success anyway so the client's fire-and-forget call
    // doesn't surface an error.
    console.warn("[events/tryon] insert failed:", error.message);
  }

  return new Response(null, { status: 204 });
}
