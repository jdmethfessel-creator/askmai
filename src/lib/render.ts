/**
 * Try-on render pipeline (Phase 3, VTON).
 *
 * Architecture: the user's real photo IS the canvas; a VTON model
 * (FASHN tryon-v1.6, falling back to Replicate IDM-VTON) warps the
 * catalog garment onto that canvas. The final share card is a
 * 1080x1920 (9:16) branded composition produced by composeShareCard,
 * where Save and Share both hand followers the same exact PNG.
 */

import { supabaseAdmin } from "./supabase";
import { tryOn, type VtonCategory } from "./vton";
import { placeBag } from "./bagPlacement";
import { composeShareCard } from "./shareCard";

export const INCLUDED_RENDERS_PER_MONTH = 3;

// Cost basis at the time of render. FASHN tryon-v1.6 in quality mode
// is ~$0.08 per generation at current pricing; updated 2026-06-28.
// Stamped onto every renders row so a future provider price change
// does not silently rewrite historical spend totals. The VTON
// provider's credit usage is also returned per-call in the result;
// this constant is just the bookkeeping basis.
const COST_USD_PER_RENDER = 0.08;

const RENDER_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

const RENDER_BUCKET = "renders";

/**
 * Read the user's current quota. Calls the get_render_quota RPC which
 * lazy-resets the included counter when the monthly window has
 * elapsed. Returns zeros if the row is missing rather than throwing,
 * because the consume RPC is the final word; the client UI uses this
 * only to choose the button label.
 */
export type RenderQuota = {
  includedRemaining: number;
  packBalance: number;
  totalRemaining: number;
};

export async function getRenderQuota(userId: string): Promise<RenderQuota> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("get_render_quota", {
    p_user_id: userId,
    p_included_limit: INCLUDED_RENDERS_PER_MONTH,
  });
  if (error) {
    console.error("[render] get_render_quota failed:", error.message);
    return { includedRemaining: 0, packBalance: 0, totalRemaining: 0 };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { includedRemaining: 0, packBalance: 0, totalRemaining: 0 };
  return {
    includedRemaining: Number(row.included_remaining ?? 0),
    packBalance: Number(row.pack_balance ?? 0),
    totalRemaining: Number(row.total_remaining ?? 0),
  };
}

/**
 * Atomic consume: included first, then pack, then deny. Returns the
 * source the credit was drawn from (so it can be logged) and the
 * post-decrement remainders. charged=false means there was no credit
 * available; in the normal flow we only call this AFTER a successful
 * upstream render, so a false here is a leak we record but do not
 * surface as an error to the user.
 */
export type ConsumeResult = {
  charged: boolean;
  source: "included" | "pack" | null;
  includedRemaining: number;
  packBalance: number;
};

export async function consumeRender(userId: string): Promise<ConsumeResult> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("consume_render", {
    p_user_id: userId,
    p_included_limit: INCLUDED_RENDERS_PER_MONTH,
  });
  if (error) {
    console.error("[render] consume_render failed:", error.message);
    return {
      charged: false,
      source: null,
      includedRemaining: 0,
      packBalance: 0,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      charged: false,
      source: null,
      includedRemaining: 0,
      packBalance: 0,
    };
  }
  const src = row.source as string | null;
  return {
    charged: Boolean(row.charged),
    source: src === "included" || src === "pack" ? src : null,
    includedRemaining: Number(row.included_remaining ?? 0),
    packBalance: Number(row.pack_balance ?? 0),
  };
}

/**
 * Append-only audit log. Fire-and-forget from the route after a
 * successful render; failures here are logged but never block the
 * response since the image is already produced and uploaded.
 */
export async function logRender(args: {
  userId: string;
  creatorSlug: string | null;
  kind: "single" | "outfit";
  itemCount: number;
  source: "included" | "pack";
  imagePath: string | null;
}): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.from("renders").insert({
    user_id: args.userId,
    creator_slug: args.creatorSlug,
    kind: args.kind,
    item_count: args.itemCount,
    source: args.source,
    cost_usd: COST_USD_PER_RENDER,
    image_path: args.imagePath,
  });
  if (error) {
    console.error("[render] log insert failed:", error.message);
  }
}

/**
 * Structured render failure type. The route handler maps these to
 * HTTP statuses (moderation_blocked -> 422, no_provider -> 500,
 * everything else -> 500). No credit is consumed when this is
 * returned; callers retry at no cost.
 */
export type RunRenderError = {
  kind:
    | "no_provider_configured"
    | "moderation_blocked"
    | "pose_error"
    | "image_load_error"
    | "garment_unsupported"
    | "timeout"
    | "error";
  message: string;
};

/**
 * Run the try-on. Throws nothing; returns the PNG buffer on success
 * or a structured failure the route maps to an HTTP status.
 *
 * Outfit mode chains FASHN calls: the output of call N becomes the
 * model_image for call N+1. Total latency scales linearly with item
 * count (~12s per item in quality mode, so an 8-item outfit runs
 * close to the maxDuration=300s budget). If any single call fails,
 * the whole render fails; partial outfits are not surfaced because
 * they read as incomplete to the user.
 */
// Subcategories the FASHN chain (Stage 1) will render onto the
// person. Worn garments only. outerwear is included because it
// occupies the same upper-body region FASHN's "tops" category
// targets; we map it via fashnCategoryFor() below.
const CHAINABLE_SUBCATEGORIES = new Set<string>([
  "tops",
  "bottoms",
  "dresses",
  "outerwear",
]);

// Subcategories handled by Stage 2 (compositing via FLUX Kontext
// on the Stage 1 result). Empty for now: bags were the first
// candidate but the model placed them in a "product demo" pose
// (held flat toward camera) and warped the person / background.
// The Stage 2 plumbing + src/lib/bagPlacement.ts stay intact so a
// future attempt (tighter pose control, or a different approach)
// can re-add bags here without re-wiring the route. See the
// commit reverting bags for the full reasoning trail.
const STAGE2_SUBCATEGORIES = new Set<string>([]);

// All renderable subcategories. Any item whose category is in this
// set passes the route's filter; items NOT in this set (shoes,
// bags, jewelry, beauty, home, outerwear, swim, other) stay in the
// items array for shoppability but get skipped entirely. Mirrors
// TRYON_ELIGIBLE_CATEGORIES in src/app/_tryon/TryOnGrid.tsx so a
// naive client can't bypass the rule.
const RENDERABLE_SUBCATEGORIES = new Set<string>([
  ...CHAINABLE_SUBCATEGORIES,
  ...STAGE2_SUBCATEGORIES,
]);

// Map our internal subcategory taxonomy to FASHN tryon-v1.6's
// `category` enum. FASHN supports auto / tops / bottoms /
// one-pieces. Bags get `auto` because FASHN has no bags enum and
// we'd rather let the model classify than pin it wrong.
//
// Passing an explicit category (vs "auto" for everything) is the
// load-bearing fix for the chained "phantom denim" artifact: when
// FASHN auto-classifies an ambiguous garment image it can place
// the wrong region or add spurious accessories (a jeans-shaped
// silhouette tied at the waist of a top render). Pinning each
// pass to the right region keeps the swap targeted.
function fashnCategoryFor(subcategory: string | null): VtonCategory {
  switch (subcategory) {
    case "tops":
      return "tops";
    case "outerwear":
      // outerwear (jackets/coats/blazers) lives in the same upper-
      // body region as tops, and FASHN has no separate enum value
      // for it. Mapping to "tops" makes the swap target the same
      // region the model is trained to handle.
      return "tops";
    case "bottoms":
      return "bottoms";
    case "dresses":
      return "one-pieces";
    default:
      return "auto";
  }
}

export async function runRender(args: {
  personBuffer: Buffer;
  personMime: string;
  /**
   * All items the client sent, in their original order. Items
   * whose category is not in CHAINABLE_SUBCATEGORIES are skipped
   * from the FASHN chain (shoes/jewelry/etc.) so the result
   * doesn't carry a residue pass that failed to place them.
   */
  items: { image_url: string; category: string | null }[];
  /**
   * Display label for the bottom strip on the share card
   * (e.g. "MADISON WALLER"). Rendered uppercase + tracked.
   * Null/empty falls back to just "ASKMAI.CO".
   */
  creatorLabel: string | null;
}): Promise<
  | { ok: true; pngBuffer: Buffer; provider: "fashn" | "replicate" }
  | { ok: false; error: RunRenderError }
> {
  if (args.items.length === 0) {
    return {
      ok: false,
      error: { kind: "error", message: "no items provided" },
    };
  }

  // Two-stage split:
  //   Stage 1 garments (CHAINABLE_SUBCATEGORIES): chained through
  //     FASHN. Each pass takes the previous output as model_image.
  //   Stage 2 bags (STAGE2_SUBCATEGORIES): composited onto the
  //     Stage 1 result via FLUX Kontext (see bagPlacement.ts).
  //     Each bag is a separate Replicate call layered onto the
  //     running image.
  //   Skipped (everything else): kept in the items array for
  //     shoppability, but never sent to any model.
  //
  // Items without a category (legacy callers / single Try-On where
  // the client knows it's eligible) default to Stage 1 garments so
  // the call path stays compatible.
  const garments: { image_url: string; category: string | null }[] = [];
  const bags: { image_url: string; category: string | null }[] = [];
  const skipped: { image_url: string; category: string | null }[] = [];
  for (const it of args.items) {
    if (it.category && STAGE2_SUBCATEGORIES.has(it.category)) {
      bags.push(it);
    } else if (!it.category || CHAINABLE_SUBCATEGORIES.has(it.category)) {
      garments.push(it);
    } else {
      skipped.push(it);
    }
  }
  if (skipped.length > 0) {
    console.log(
      `[render] skipping ${skipped.length} non-renderable item(s): [${skipped
        .map((s) => s.category ?? "?")
        .join(", ")}]`
    );
  }
  if (garments.length === 0 && bags.length === 0) {
    return {
      ok: false,
      error: {
        kind: "garment_unsupported",
        message: `no renderable items: all ${args.items.length} were skipped categories`,
      },
    };
  }

  // -------- Stage 1: garment chain via FASHN -----------------------
  // Each pass output becomes the next pass's model_image. For a
  // bag-only outfit (0 garments) Stage 1 is a no-op and Stage 2
  // composites onto the user's normalized canvas directly per
  // JD's spec ("Always a FASHN-quality person underneath first" -
  // the canvas IS the FASHN-quality person from upload-time
  // normalization).
  let workingPerson = args.personBuffer;
  let workingMime = args.personMime;
  let stage1Provider: "fashn" | "replicate" | "canvas" = "canvas";

  for (let i = 0; i < garments.length; i++) {
    const it = garments[i];
    const fashnCat = fashnCategoryFor(it.category);
    const r = await tryOn({
      personBuffer: workingPerson,
      personMime: workingMime,
      garmentImageUrl: it.image_url,
      category: fashnCat,
      garmentPhotoType: "model",
    });

    if (!r.ok) {
      console.error(
        `[render] stage1 garment ${i + 1}/${garments.length} (${it.category ?? "?"} -> ${fashnCat}) failed reason=${r.reason} detail=${r.detail}`
      );
      return {
        ok: false,
        error: {
          kind: r.reason === "no_provider_configured" ? "no_provider_configured" : r.reason,
          message: r.detail,
        },
      };
    }

    console.log(
      `[render] stage1 garment ${i + 1}/${garments.length} (${it.category ?? "?"} -> ${fashnCat}) ok provider=${r.provider} runtime=${r.runtimeMs}ms${r.creditsUsed != null ? ` credits=${r.creditsUsed}` : ""}`
    );

    workingPerson = r.pngBuffer;
    workingMime = "image/png";
    stage1Provider = r.provider;
  }

  // -------- Stage 2: bag composite via FLUX Kontext ---------------
  // Each bag is layered onto the running image. If a bag step
  // fails, log the failure and KEEP the pre-bag image: the user
  // gets a valid render (just without that bag) instead of a hard
  // failure. Per JD's spec: "If Stage 2 fails or is low confidence,
  // return the Stage 1 FASHN image without the bag rather than a
  // broken render (no credit charged for the bag step on failure)."
  // The render credit is consumed once total at the route level;
  // bag-step failures don't add a separate charge.
  for (let i = 0; i < bags.length; i++) {
    const it = bags[i];
    const result = await placeBag({
      baseImageBuffer: workingPerson,
      bagImageUrl: it.image_url,
    });
    if (!result.ok) {
      console.warn(
        `[render] stage2 bag ${i + 1}/${bags.length} failed reason=${result.reason} detail=${result.detail} (keeping pre-bag image)`
      );
      // Skip just this bag; continue with remaining bags on the
      // pre-bag image. Multi-bag outfits aren't a thing today
      // (slot map enforces one bag) but the loop is defensive.
      continue;
    }
    console.log(
      `[render] stage2 bag ${i + 1}/${bags.length} ok runtime=${result.runtimeMs}ms`
    );
    workingPerson = result.pngBuffer;
    workingMime = "image/png";
  }

  // Final image is the workingPerson after both stages. Provider
  // tag for the route caller reflects Stage 1's source (the bag
  // step is additive; the canonical "who made this" is the FASHN
  // /  Replicate VTON or the canvas itself).
  const finalProvider: "fashn" | "replicate" =
    stage1Provider === "canvas" ? "fashn" : stage1Provider;

  // Compose the final 1080x1920 (9:16) share card: blur-extend
  // background sampled from the VTON output's own colors, contain-fit
  // foreground so head-to-feet stays visible, cream brand pill, and a
  // bottom context strip with the creator label + askmai.co. Save and
  // Share both hand followers this exact PNG downstream.
  try {
    const branded = await composeShareCard(workingPerson, {
      creatorLabel: args.creatorLabel,
    });
    return { ok: true, pngBuffer: branded, provider: finalProvider };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[render] share-card compose failed:", msg);
    return { ok: false, error: { kind: "error", message: msg } };
  }
}

/**
 * Upload the finished PNG to the private renders bucket. Path layout
 * mirrors the tryon-photos bucket: `{userId}/{uuid}.png`. Returns the
 * storage path plus a short-lived signed URL the client can render.
 */
export async function uploadRender(args: {
  userId: string;
  pngBuffer: Buffer;
}): Promise<{ path: string; signedUrl: string }> {
  const sb = supabaseAdmin();
  const uuid = crypto.randomUUID();
  const renderPath = `${args.userId}/${uuid}.png`;
  const up = await sb.storage
    .from(RENDER_BUCKET)
    .upload(renderPath, args.pngBuffer, {
      contentType: "image/png",
      upsert: false,
    });
  if (up.error) {
    throw new Error(`render upload failed: ${up.error.message}`);
  }
  const signed = await sb.storage
    .from(RENDER_BUCKET)
    .createSignedUrl(renderPath, RENDER_SIGNED_URL_TTL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) {
    throw new Error(
      `render sign failed: ${signed.error?.message ?? "unknown"}`
    );
  }
  return { path: renderPath, signedUrl: signed.data.signedUrl };
}

/**
 * Download the user's uploaded try-on photo from the private bucket.
 * Returns the raw bytes plus mime so runRender can pass them straight
 * into the VTON call as the model_image.
 */
export async function fetchPersonPhoto(
  tryonPhotoPath: string
): Promise<{ buffer: Buffer; mime: string }> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage
    .from("tryon-photos")
    .download(tryonPhotoPath);
  if (error || !data) {
    throw new Error(
      `person photo download failed: ${error?.message ?? "no data"}`
    );
  }
  const buffer = Buffer.from(await data.arrayBuffer());
  const mime = data.type || "image/jpeg";
  return { buffer, mime };
}
