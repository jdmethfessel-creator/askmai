/**
 * Virtual try-on (VTON) provider abstraction.
 *
 * Primary: FASHN `tryon-v1.6` via the `fashn` npm SDK.
 *   - Identity-preserving: the user's real photo IS the base image.
 *     The model warps the garment onto the figure without
 *     regenerating face / hair / body / background.
 *   - Output: 864x1296 PNG (we upscale to 1024x1536 in the branding
 *     step so the wordmark overlay aligns).
 *   - Modes: performance (~5s), balanced (~8s), quality (~12-17s).
 *     Defaulting to `quality` because the AskMai output is a share
 *     card, not a thumbnail.
 *   - Failed predictions are NOT charged on the FASHN side
 *     (confirmed in reference.md), so a failure costs us nothing.
 *
 * Fallback: Replicate `cuuupid/idm-vton`.
 *   - Triggered only when FASHN_API_KEY is missing or the FASHN call
 *     fails with an auth/network signal (not when FASHN returns a
 *     legitimate runtime failure like ContentModerationError, which
 *     is a content issue the fallback won't paper over).
 *   - REPLICATE_API_TOKEN is already wired in production (was used
 *     by the prior face-swap path); reusing it here is zero-config.
 *
 * The route handler calls tryOn() and gets back a structured result.
 * On success: { ok: true, pngBuffer, provider, ... }. On failure: a
 * reason code the route maps to the right HTTP status (e.g.
 * moderation_blocked -> 422, anything else -> 500). The credit guard
 * lives in the route, not here; no credit is consumed unless this
 * returns ok: true.
 */

import Fashn from "fashn";

// FASHN model name. JD picked v1.6 explicitly over the flagship
// tryon-max for speed + cost. v1.6 lands a render in ~12s at
// quality mode; tryon-max is ~30-60s. Swap this string to upgrade.
const FASHN_MODEL = "tryon-v1.6";

// Quality > speed for share-card output. JD's surface is a portrait
// share image that needs to look real at full screen, not a 64px
// product tile. balanced -> quality is roughly +4s for noticeably
// crisper hands / garment-skin boundaries.
const FASHN_MODE: "performance" | "balanced" | "quality" = "quality";

// FASHN subscribe() poll timeout. Default is 300s; we set 240s so
// the timer here trips before the Vercel function maxDuration=300
// and we get a clean structured error instead of a runtime kill
// with no actionable trace.
const FASHN_TIMEOUT_MS = 240_000;

// Replicate IDM-VTON wrapper. cuuupid/idm-vton is the most-used
// public IDM-VTON model on Replicate; input shape matches the paper
// reference implementation.
//
// Two endpoint options on Replicate:
//   POST /v1/models/{owner}/{name}/predictions  - "latest" alias,
//     only works if the model has a default version pinned by the
//     owner. cuuupid/idm-vton does NOT have one (returns 404), so
//     this shortcut fails for it.
//   POST /v1/predictions  with { version, input }  - works for any
//     model. We pin the version hash explicitly.
//
// Pinned version: latest as of 2026-06-28 from
// https://replicate.com/cuuupid/idm-vton/versions . Update when a
// newer version ships with a notable quality jump. The version
// pinning also makes the renders deterministic across deploys: a
// silent model swap by the maintainer doesn't change our output.
const REPLICATE_MODEL = "cuuupid/idm-vton";
const REPLICATE_VERSION =
  "0513734a452173b8173e907e3a59d19a36266e55b48528559432bd21c7d7e985";
const REPLICATE_API = "https://api.replicate.com/v1";
const REPLICATE_WAIT_SECONDS = 60;
const REPLICATE_POLL_INTERVAL_MS = 1500;
const REPLICATE_TOTAL_TIMEOUT_MS = 240_000;

const DOWNLOAD_TIMEOUT_MS = 30_000;

export type VtonCategory = "auto" | "tops" | "bottoms" | "one-pieces";
export type VtonGarmentPhotoType = "auto" | "flat-lay" | "model";

export type VtonFailureReason =
  | "no_provider_configured" // neither FASHN_API_KEY nor REPLICATE_API_TOKEN set
  | "moderation_blocked" // FASHN ContentModerationError or Replicate safety filter
  | "pose_error" // FASHN PoseError (person not detectable / odd pose)
  | "image_load_error" // FASHN ImageLoadError (garment URL unfetchable)
  | "garment_unsupported" // garment category isn't in scope for the model
  | "timeout"
  | "error";

export type VtonResult =
  | {
      ok: true;
      pngBuffer: Buffer;
      provider: "fashn" | "replicate";
      runtimeMs: number;
      creditsUsed?: number;
    }
  | { ok: false; reason: VtonFailureReason; detail: string };

/**
 * Try the FASHN call first; on missing key or auth/network signal,
 * fall through to Replicate IDM-VTON. Content/moderation failures
 * from FASHN do NOT fall through (those are about the inputs, not
 * the provider).
 */
export async function tryOn(args: {
  personBuffer: Buffer;
  personMime: string;
  garmentImageUrl: string;
  category?: VtonCategory;
  garmentPhotoType?: VtonGarmentPhotoType;
}): Promise<VtonResult> {
  const hasFashn = !!process.env.FASHN_API_KEY;
  const hasReplicate = !!process.env.REPLICATE_API_TOKEN;

  if (!hasFashn && !hasReplicate) {
    return {
      ok: false,
      reason: "no_provider_configured",
      detail:
        "Neither FASHN_API_KEY nor REPLICATE_API_TOKEN is set in the environment",
    };
  }

  if (hasFashn) {
    const r = await runFashn(args);
    // Don't fall through on content-side failures (the inputs are
    // the problem; Replicate would reject them too and burn extra
    // latency).
    if (r.ok) return r;
    if (
      r.reason === "moderation_blocked" ||
      r.reason === "pose_error" ||
      r.reason === "image_load_error" ||
      r.reason === "garment_unsupported"
    ) {
      return r;
    }
    // Provider-side failure (auth, network, FASHN outage). Fall
    // through to Replicate if it's available.
    if (hasReplicate) {
      console.warn(
        `[vton] FASHN failed with reason=${r.reason}, falling back to Replicate IDM-VTON. detail=${r.detail}`
      );
      return runReplicate(args);
    }
    return r;
  }

  return runReplicate(args);
}

// -------- FASHN ----------------------------------------------------

async function runFashn(args: {
  personBuffer: Buffer;
  personMime: string;
  garmentImageUrl: string;
  category?: VtonCategory;
  garmentPhotoType?: VtonGarmentPhotoType;
}): Promise<VtonResult> {
  const startedAt = Date.now();

  // Person as a data URI so FASHN doesn't need our Supabase signed
  // URL exposed externally. The bucket is private and signed URLs
  // would work too, but base64 in-band avoids the round-trip and
  // keeps the photo off the public internet.
  const personDataUri = `data:${args.personMime};base64,${args.personBuffer.toString("base64")}`;

  let client: Fashn;
  try {
    client = new Fashn(); // reads FASHN_API_KEY from env
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[vton:fashn] client init failed", msg);
    return { ok: false, reason: "error", detail: `FASHN init: ${msg}` };
  }

  type FashnResult = {
    status: string;
    output?: string[] | null;
    error?: { name?: string; message?: string } | null;
    creditsUsed?: number;
    id?: string;
  };

  let result: FashnResult;
  try {
    result = (await client.predictions.subscribe({
      model_name: FASHN_MODEL,
      inputs: {
        model_image: personDataUri,
        garment_image: args.garmentImageUrl,
        garment_photo_type: args.garmentPhotoType ?? "model",
        category: args.category ?? "auto",
        mode: FASHN_MODE,
      },
      timeout: FASHN_TIMEOUT_MS,
    })) as FashnResult;
  } catch (err) {
    // API-level errors (4xx/5xx pre-job): auth, billing, rate limit,
    // model-not-found. These are provider-side; the caller may want
    // to fall back to Replicate.
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as { status?: number })?.status;
    console.error(
      "[vton:fashn] subscribe threw",
      JSON.stringify({ status, message: msg, model: FASHN_MODEL })
    );
    const reason: VtonFailureReason = msg.toLowerCase().includes("timeout")
      ? "timeout"
      : "error";
    return { ok: false, reason, detail: `FASHN ${status ?? "?"}: ${msg}` };
  }

  if (result.status !== "completed") {
    // Runtime failure. The job ran but produced no usable output.
    // Bucket the known FASHN error names so the route can render the
    // right user message ("flagged", "couldn't see you", "couldn't
    // load that garment image").
    const errName = result.error?.name || "";
    const errMsg = result.error?.message || result.status || "unknown";
    console.error(
      "[vton:fashn] runtime failure",
      JSON.stringify({
        id: result.id,
        status: result.status,
        errorName: errName,
        errorMessage: errMsg,
      })
    );
    if (/ContentModeration/i.test(errName)) {
      return { ok: false, reason: "moderation_blocked", detail: errMsg };
    }
    if (/Pose/i.test(errName)) {
      return { ok: false, reason: "pose_error", detail: errMsg };
    }
    if (/ImageLoad/i.test(errName)) {
      return { ok: false, reason: "image_load_error", detail: errMsg };
    }
    return { ok: false, reason: "error", detail: `${errName}: ${errMsg}` };
  }

  const outputUrl = result.output?.[0];
  if (!outputUrl) {
    return {
      ok: false,
      reason: "error",
      detail: "FASHN completed without output URL",
    };
  }

  const downloaded = await downloadImage(outputUrl);
  if (!downloaded.ok) return downloaded;

  return {
    ok: true,
    pngBuffer: downloaded.pngBuffer,
    provider: "fashn",
    runtimeMs: Date.now() - startedAt,
    creditsUsed: result.creditsUsed,
  };
}

// -------- Replicate IDM-VTON fallback -------------------------------

type ReplicatePrediction = {
  id?: string;
  status?: string;
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
};

async function runReplicate(args: {
  personBuffer: Buffer;
  personMime: string;
  garmentImageUrl: string;
  category?: VtonCategory;
}): Promise<VtonResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: "no_provider_configured",
      detail: "REPLICATE_API_TOKEN not set",
    };
  }

  const startedAt = Date.now();

  // IDM-VTON expects URL-shaped inputs. Person goes as data URI;
  // garment passed through as the catalog URL.
  const personDataUri = `data:${args.personMime};base64,${args.personBuffer.toString("base64")}`;

  // IDM-VTON has a `garment_des` text field. It influences how the
  // garment is interpreted; we don't have rich text for catalog rows
  // so pass a generic label keyed off the category.
  const description = describeGarment(args.category);

  let prediction: ReplicatePrediction;
  try {
    const create = await fetch(`${REPLICATE_API}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Token ${token}`,
        "Content-Type": "application/json",
        Prefer: `wait=${REPLICATE_WAIT_SECONDS}`,
      },
      body: JSON.stringify({
        version: REPLICATE_VERSION,
        input: {
          human_img: personDataUri,
          garm_img: args.garmentImageUrl,
          garment_des: description,
        },
      }),
      signal: AbortSignal.timeout(REPLICATE_TOTAL_TIMEOUT_MS),
    });
    if (!create.ok) {
      const text = await create.text().catch(() => "");
      console.error(
        "[vton:replicate] create failed",
        JSON.stringify({
          httpStatus: create.status,
          body: text.slice(0, 1500),
          model: REPLICATE_MODEL,
          version: REPLICATE_VERSION,
        })
      );
      return {
        ok: false,
        reason: "error",
        detail: `Replicate HTTP ${create.status}: ${text.slice(0, 200)}`,
      };
    }
    prediction = (await create.json()) as ReplicatePrediction;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: msg.toLowerCase().includes("timeout") ? "timeout" : "error",
      detail: `Replicate create: ${msg}`,
    };
  }

  while (
    prediction.status !== "succeeded" &&
    prediction.status !== "failed" &&
    prediction.status !== "canceled"
  ) {
    if (Date.now() - startedAt > REPLICATE_TOTAL_TIMEOUT_MS) {
      return {
        ok: false,
        reason: "timeout",
        detail: `Replicate polling exceeded ${REPLICATE_TOTAL_TIMEOUT_MS}ms last=${prediction.status}`,
      };
    }
    await new Promise((r) => setTimeout(r, REPLICATE_POLL_INTERVAL_MS));
    const pollUrl = prediction.urls?.get;
    if (!pollUrl) {
      return {
        ok: false,
        reason: "error",
        detail: "Replicate response missing urls.get",
      };
    }
    try {
      const poll = await fetch(pollUrl, {
        headers: { Authorization: `Token ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!poll.ok) {
        const text = await poll.text().catch(() => "");
        console.error(
          "[vton:replicate] poll failed",
          JSON.stringify({ httpStatus: poll.status, body: text.slice(0, 800) })
        );
        return {
          ok: false,
          reason: "error",
          detail: `Replicate poll HTTP ${poll.status}`,
        };
      }
      prediction = (await poll.json()) as ReplicatePrediction;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: "error", detail: `Replicate poll: ${msg}` };
    }
  }

  if (prediction.status !== "succeeded") {
    const errStr = String(prediction.error || prediction.status || "unknown");
    console.error(
      "[vton:replicate] prediction failed",
      JSON.stringify({
        id: prediction.id,
        status: prediction.status,
        error: prediction.error,
      })
    );
    if (/safety|moderation|nsfw|sexual|inappropriate/i.test(errStr)) {
      return { ok: false, reason: "moderation_blocked", detail: errStr };
    }
    return { ok: false, reason: "error", detail: errStr };
  }

  const outputUrl = Array.isArray(prediction.output)
    ? prediction.output[0]
    : prediction.output;
  if (!outputUrl || typeof outputUrl !== "string") {
    return {
      ok: false,
      reason: "error",
      detail: `Replicate succeeded but output not URL: ${JSON.stringify(prediction.output)}`,
    };
  }

  const downloaded = await downloadImage(outputUrl);
  if (!downloaded.ok) return downloaded;

  return {
    ok: true,
    pngBuffer: downloaded.pngBuffer,
    provider: "replicate",
    runtimeMs: Date.now() - startedAt,
  };
}

// -------- helpers --------------------------------------------------

async function downloadImage(url: string): Promise<
  | { ok: true; pngBuffer: Buffer }
  | { ok: false; reason: VtonFailureReason; detail: string }
> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        detail: `output download HTTP ${res.status}`,
      };
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      return {
        ok: false,
        reason: "error",
        detail: `output not an image (content-type: ${ct})`,
      };
    }
    return { ok: true, pngBuffer: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: msg.toLowerCase().includes("timeout") ? "timeout" : "error",
      detail: `download: ${msg}`,
    };
  }
}

function describeGarment(category: VtonCategory | undefined): string {
  switch (category) {
    case "tops":
      return "top";
    case "bottoms":
      return "bottoms";
    case "one-pieces":
      return "dress";
    default:
      return "garment";
  }
}
