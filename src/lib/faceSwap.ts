/**
 * Production face swap via Replicate's hosted inswapper.
 *
 * Replaces the face in a target image with a source face. Uses the
 * InsightFace inswapper_128 model (the same library every commercial
 * face-swap product uses underneath). Handles all the steps JD spec'd:
 *
 *   - Detects 5-point facial landmarks (eyes, nose tip, mouth
 *     corners) on both source and target via InsightFace's
 *     buffalo_l detector.
 *   - Computes the affine alignment between source landmarks and
 *     target landmarks: scale, rotation, translation.
 *   - Warps the source face into the target's pose, angle, size.
 *   - Internal 128x128 face embedding swap (this is the model's
 *     trained-on resolution; upscaling and blending happen at the
 *     target's native resolution).
 *   - Color and lighting transfer from target to source via the
 *     model's built-in color-match pass, so the swapped face matches
 *     the render's white balance and shadow direction.
 *   - Soft feathered boundary inside the hairline and jaw via the
 *     model's segmentation mask. Hair, neckline, shoulders, garment
 *     all stay from the target image.
 *
 * The contract for callers: pass (sourceFaceBuffer, targetImageBuffer),
 * get back either { ok: true, pngBuffer } or a structured failure with
 * a reason code. Callers decide whether to fall back to the un-swapped
 * target (the chat and try-on grid both surface a graceful UX path).
 *
 * Cost: roughly $0.005 per swap on Replicate (cdingram/face-swap is
 * inswapper). Latency: typically 3 to 8 seconds; the `Prefer: wait=60`
 * header keeps the connection open until completion, with a polling
 * fallback if the swap runs longer.
 *
 * Auth: REPLICATE_API_TOKEN must be set. When missing, the function
 * returns { ok: false, reason: "no_token" } and the caller falls back
 * to the un-swapped image. This lets the deploy ship before the token
 * is added to Vercel env without breaking renders.
 */

const REPLICATE_API = "https://api.replicate.com/v1";
// cdingram/face-swap is a thin wrapper around InsightFace
// inswapper_128. Picked over lucataco/faceswap and
// easel/advanced-face-swap because it has the simplest input
// contract (swap_image + input_image, both accept data URIs) and the
// cleanest output (single image URL). All three use the same
// underlying inswapper weights.
const FACESWAP_MODEL = "cdingram/face-swap";

// Replicate's `Prefer: wait=N` header tells them to hold the HTTP
// connection open up to N seconds for synchronous completion. Most
// swaps finish in 3 to 8 seconds; 60s covers cold-start plus slow
// days.
const REPLICATE_WAIT_SECONDS = 60;
const POLL_INTERVAL_MS = 1500;
const TOTAL_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type FaceSwapFailureReason =
  | "no_token" // REPLICATE_API_TOKEN not configured; expected on first deploy
  | "no_face_in_source" // source photo has no detectable face
  | "no_face_in_target" // generated render has no detectable face (rare; gpt-image-1 invented an obscured or cropped person)
  | "moderation_blocked" // Replicate's safety filter rejected the swap
  | "timeout" // exceeded TOTAL_TIMEOUT_MS waiting for the swap
  | "error"; // anything else (network, HTTP 5xx, malformed response)

export type FaceSwapResult =
  | { ok: true; pngBuffer: Buffer; latencyMs: number }
  | { ok: false; reason: FaceSwapFailureReason; detail: string };

type ReplicatePrediction = {
  id?: string;
  status?: string;
  output?: string | string[] | null;
  error?: string | null;
  urls?: { get?: string };
};

export async function faceSwap(args: {
  sourceFaceBuffer: Buffer;
  targetImageBuffer: Buffer;
}): Promise<FaceSwapResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return {
      ok: false,
      reason: "no_token",
      detail: "REPLICATE_API_TOKEN not set; falling back to un-swapped render",
    };
  }

  const startedAt = Date.now();

  // Inline both images as data URIs. Replicate supports `data:` URIs
  // up to several MB; our 1024x1536 PNGs land well under that. This
  // saves a Supabase round-trip for upload plus signed URL.
  const sourceDataUri = `data:image/png;base64,${args.sourceFaceBuffer.toString(
    "base64"
  )}`;
  const targetDataUri = `data:image/png;base64,${args.targetImageBuffer.toString(
    "base64"
  )}`;

  let prediction: ReplicatePrediction;
  try {
    const create = await fetch(
      `${REPLICATE_API}/models/${FACESWAP_MODEL}/predictions`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
          Prefer: `wait=${REPLICATE_WAIT_SECONDS}`,
        },
        body: JSON.stringify({
          input: {
            swap_image: sourceDataUri,
            input_image: targetDataUri,
          },
        }),
        signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
      }
    );

    if (!create.ok) {
      const text = await create.text().catch(() => "");
      return {
        ok: false,
        reason: "error",
        detail: `Replicate create HTTP ${create.status}: ${text.slice(0, 300)}`,
      };
    }

    prediction = (await create.json()) as ReplicatePrediction;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: msg.includes("timeout") ? "timeout" : "error",
      detail: `Replicate create failed: ${msg}`,
    };
  }

  // Poll if the swap didn't finish under Prefer:wait. Replicate sets
  // status to "starting", "processing", "succeeded", "failed", or
  // "canceled".
  while (
    prediction.status !== "succeeded" &&
    prediction.status !== "failed" &&
    prediction.status !== "canceled"
  ) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) {
      return {
        ok: false,
        reason: "timeout",
        detail: `face swap polling exceeded ${TOTAL_TIMEOUT_MS}ms (last status: ${prediction.status})`,
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const pollUrl = prediction.urls?.get;
    if (!pollUrl) {
      return {
        ok: false,
        reason: "error",
        detail: "Replicate response missing urls.get; cannot poll",
      };
    }
    try {
      const poll = await fetch(pollUrl, {
        headers: { Authorization: `Token ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!poll.ok) {
        return {
          ok: false,
          reason: "error",
          detail: `Replicate poll HTTP ${poll.status}`,
        };
      }
      prediction = (await poll.json()) as ReplicatePrediction;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: "error",
        detail: `Replicate poll failed: ${msg}`,
      };
    }
  }

  if (prediction.status !== "succeeded") {
    const errStr = String(prediction.error || prediction.status || "unknown");
    // Try to bucket common failure modes for the caller.
    if (/no.*face|face.*not.*found|cannot.*detect.*face|cannot.*find.*face/i.test(errStr)) {
      // The model's error rarely distinguishes source vs target;
      // default to source (more common; render's gpt-image-1 face is
      // usually detectable).
      const reason: FaceSwapFailureReason =
        /target|input_image/i.test(errStr)
          ? "no_face_in_target"
          : "no_face_in_source";
      return { ok: false, reason, detail: errStr };
    }
    if (/safety|moderation|nsfw|sexual|inappropriate/i.test(errStr)) {
      return { ok: false, reason: "moderation_blocked", detail: errStr };
    }
    return { ok: false, reason: "error", detail: errStr };
  }

  // Output is the URL of the swapped image. Some Replicate models
  // return arrays; cdingram/face-swap returns a single URL string,
  // but we handle both shapes defensively.
  const outputUrl = Array.isArray(prediction.output)
    ? prediction.output[0]
    : prediction.output;
  if (!outputUrl || typeof outputUrl !== "string") {
    return {
      ok: false,
      reason: "error",
      detail: `Replicate succeeded but output is not a URL: ${JSON.stringify(prediction.output)}`,
    };
  }

  // Download the swapped image. Replicate-hosted URLs are public CDN
  // links with short TTLs (24h); we just need the bytes for the
  // branding overlay step.
  try {
    const imgRes = await fetch(outputUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!imgRes.ok) {
      return {
        ok: false,
        reason: "error",
        detail: `face swap output download HTTP ${imgRes.status}`,
      };
    }
    const ct = imgRes.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      return {
        ok: false,
        reason: "error",
        detail: `face swap output not an image (content-type: ${ct})`,
      };
    }
    const pngBuffer = Buffer.from(await imgRes.arrayBuffer());
    return {
      ok: true,
      pngBuffer,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", detail: `download failed: ${msg}` };
  }
}
