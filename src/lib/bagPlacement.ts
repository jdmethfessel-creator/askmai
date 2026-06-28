/**
 * Stage 2 of the try-on pipeline: composite a specific catalog bag
 * onto an already-rendered Stage 1 image.
 *
 * Architecture (per JD's two-stage spec):
 *   Stage 1 (FASHN): renders the person + any clothing onto the
 *     user's normalized canvas. If the outfit has no garments, Stage 1
 *     is just the canvas itself (neutral basics from upload-time
 *     normalization). This stage does NOT know about bags.
 *   Stage 2 (this module): takes Stage 1's PNG and composites the
 *     real catalog bag product image into the hand or over the
 *     shoulder, identity/pose/clothing/background preserved exactly.
 *     Only runs when the outfit includes a bag.
 *
 * Model: black-forest-labs FLUX.1 Kontext (Max) via Replicate's
 * `flux-kontext-apps/multi-image-kontext-max`. Purpose-built for
 * combining two input images via a text prompt; takes
 * input_image_1 (the scene) + input_image_2 (the subject to
 * insert) + a text prompt describing where to put it. This is the
 * tool for "insert THIS specific bag into THIS image" with high
 * fidelity to the bag's actual color / hardware / silhouette,
 * which a text-only edit can't deliver.
 *
 * Cost: ~$0.08 per call on Replicate (FLUX Kontext Max pricing).
 * Latency: typically 6-12s.
 *
 * Failure behavior: caller's responsibility. This module returns a
 * structured failure result; runRender treats Stage 2 failures as
 * "ship the Stage 1 image without the bag" rather than fail the
 * whole render. Replicate doesn't charge for failed predictions,
 * so a failed Stage 2 costs nothing on the provider side; the
 * user is still charged one render credit (for the successful
 * Stage 1) per JD's spec.
 */

const REPLICATE_API = "https://api.replicate.com/v1";
// Use the latest-version shortcut endpoint; flux-kontext-apps models
// have a stable default version pin by the maintainer. If we see
// 404 / "no default version" in production we'd switch to the
// version-pinned /v1/predictions path (as we already do for the
// IDM-VTON fallback in vton.ts).
const REPLICATE_MODEL = "flux-kontext-apps/multi-image-kontext-max";

const REPLICATE_WAIT_SECONDS = 60;
const REPLICATE_POLL_INTERVAL_MS = 1500;
const REPLICATE_TOTAL_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const BAG_PLACEMENT_PROMPT =
  "Place the handbag from image 2 naturally into the scene from image 1: held in her hand by the top handle, OR draped over her shoulder by its strap, whichever reads more natural for her pose. The bag must match image 2 exactly: same color, hardware, shape, material, logo. Realistic scale relative to her body, natural arm position if she's holding it. Preserve image 1's person identity, face, hair, body, clothing, lighting, and background exactly. Photorealistic. Do not change anything else in image 1.";

export type BagPlacementFailureReason =
  | "no_token"
  | "moderation_blocked"
  | "image_load_error"
  | "timeout"
  | "error";

export type BagPlacementResult =
  | { ok: true; pngBuffer: Buffer; runtimeMs: number }
  | { ok: false; reason: BagPlacementFailureReason; detail: string };

type ReplicatePrediction = {
  id?: string;
  status?: string;
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
};

export async function placeBag(args: {
  /** Stage 1 output: the FASHN-rendered person, branded-or-not, as PNG bytes. */
  baseImageBuffer: Buffer;
  /** The bag product image URL from creator_products (catalog CDN). */
  bagImageUrl: string;
}): Promise<BagPlacementResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: "no_token",
      detail: "REPLICATE_API_TOKEN not set; skipping bag placement",
    };
  }

  const startedAt = Date.now();

  // Stage 1 image goes as data URI; the catalog bag URL passes
  // through as-is (Replicate fetches it server-side). The catalog
  // URLs are public CDN links (Amazon Shopbop / FWRD / ShopMy)
  // already known to be fetchable by external services.
  const baseDataUri = `data:image/png;base64,${args.baseImageBuffer.toString("base64")}`;

  let prediction: ReplicatePrediction;
  try {
    const create = await fetch(
      `${REPLICATE_API}/models/${REPLICATE_MODEL}/predictions`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
          Prefer: `wait=${REPLICATE_WAIT_SECONDS}`,
        },
        body: JSON.stringify({
          input: {
            input_image_1: baseDataUri,
            input_image_2: args.bagImageUrl,
            prompt: BAG_PLACEMENT_PROMPT,
            aspect_ratio: "match_input_image",
            output_format: "png",
            safety_tolerance: 2,
          },
        }),
        signal: AbortSignal.timeout(REPLICATE_TOTAL_TIMEOUT_MS),
      }
    );
    if (!create.ok) {
      const text = await create.text().catch(() => "");
      console.error(
        "[bagPlacement] Replicate create failed",
        JSON.stringify({
          httpStatus: create.status,
          body: text.slice(0, 1500),
          model: REPLICATE_MODEL,
        })
      );
      return {
        ok: false,
        reason: "error",
        detail: `Replicate HTTP ${create.status}: ${text.slice(0, 200)}`,
      };
    }
    prediction = (await create.json()) as ReplicatePrediction;
    console.log(
      "[bagPlacement] Replicate create accepted",
      JSON.stringify({
        id: prediction.id,
        status: prediction.status,
        model: REPLICATE_MODEL,
      })
    );
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
        detail: `Replicate polling exceeded ${REPLICATE_TOTAL_TIMEOUT_MS}ms (last=${prediction.status})`,
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
          "[bagPlacement] Replicate poll failed",
          JSON.stringify({
            httpStatus: poll.status,
            body: text.slice(0, 800),
          })
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
      "[bagPlacement] Replicate prediction failed",
      JSON.stringify({
        id: prediction.id,
        status: prediction.status,
        error: prediction.error,
      })
    );
    if (/safety|moderation|nsfw|sexual|inappropriate/i.test(errStr)) {
      return { ok: false, reason: "moderation_blocked", detail: errStr };
    }
    if (/image.*load|cannot.*load|fetch.*failed|404/i.test(errStr)) {
      return { ok: false, reason: "image_load_error", detail: errStr };
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

  try {
    const res = await fetch(outputUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "error",
        detail: `bag output download HTTP ${res.status}`,
      };
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      return {
        ok: false,
        reason: "error",
        detail: `bag output not an image (content-type: ${ct})`,
      };
    }
    return {
      ok: true,
      pngBuffer: Buffer.from(await res.arrayBuffer()),
      runtimeMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", detail: `download: ${msg}` };
  }
}
