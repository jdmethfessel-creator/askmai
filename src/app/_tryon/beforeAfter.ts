/**
 * Client-side composition utilities for the before/after share
 * outputs. Both run entirely in the browser:
 *
 *   composeSideBySide(beforeUrl, afterUrl) -> PNG Blob
 *     Two-column 2048x1536 still: before on the left, after on the
 *     right, each contain-fit into a 1024x1536 slot with a mid-gray
 *     pad. Thin labels ("Before" / "After") above each column and a
 *     small AskMai mark at the bottom. Used for the "Save image"
 *     download.
 *
 *   composeRevealVideo(beforeUrl, afterUrl) -> Blob (mp4 or webm)
 *     Vertical 9:16 (1024x1820) loop, ~4s. Sequence:
 *       0.0-0.5s   hold on before
 *       0.5-2.0s   wipe left-to-right (before -> after)
 *       2.0-4.0s   hold on after
 *     Captured via MediaRecorder + canvas.captureStream. MIME-type
 *     negotiated per browser (Safari -> mp4, Chrome/Firefox -> webm).
 *     Both share-API-compatible.
 *
 * Both functions accept signed URLs (Supabase short-lived links).
 * Images are loaded with crossorigin="anonymous" so the canvas
 * stays exportable (Supabase serves the right CORS headers for
 * signed URLs).
 */

const CANVAS_W = 1024;
const CANVAS_H = 1536;
const VIDEO_W = 1024;
const VIDEO_H = 1820; // 9:16 aspect, the TikTok/Reels native
const PAD_RGB = "rgb(144,144,144)"; // matches render's pad color

const REVEAL_HOLD_BEFORE_MS = 500;
const REVEAL_WIPE_MS = 1500;
const REVEAL_HOLD_AFTER_MS = 2000;
const REVEAL_TOTAL_MS =
  REVEAL_HOLD_BEFORE_MS + REVEAL_WIPE_MS + REVEAL_HOLD_AFTER_MS;
const VIDEO_FPS = 30;

const SIDE_PAD_TOP = 80; // room for the "Before / After" labels
const SIDE_PAD_BOTTOM = 80; // room for the AskMai mark
const SIDE_COL_W = CANVAS_W;
const SIDE_COL_H = CANVAS_H;
const SIDE_TOTAL_W = SIDE_COL_W * 2;
const SIDE_TOTAL_H = SIDE_PAD_TOP + SIDE_COL_H + SIDE_PAD_BOTTOM;

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

/**
 * Contain-fit draw of an image into (x, y, w, h) with the gray pad
 * filling any letterbox bars. Mirrors the server's placeOnSafeCanvas
 * behavior so the before doesn't overflow the after's frame.
 */
function drawContain(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number
) {
  ctx.fillStyle = PAD_RGB;
  ctx.fillRect(x, y, w, h);
  if (!img.naturalWidth || !img.naturalHeight) return;
  const scale = Math.min(w / img.naturalWidth, h / img.naturalHeight);
  const dw = img.naturalWidth * scale;
  const dh = img.naturalHeight * scale;
  const dx = x + (w - dw) / 2;
  const dy = y + (h - dh) / 2;
  ctx.drawImage(img, dx, dy, dw, dh);
}

export async function composeSideBySide(
  beforeUrl: string,
  afterUrl: string
): Promise<Blob> {
  const [before, after] = await Promise.all([
    loadImage(beforeUrl),
    loadImage(afterUrl),
  ]);
  const canvas = document.createElement("canvas");
  canvas.width = SIDE_TOTAL_W;
  canvas.height = SIDE_TOTAL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  // Background: same gray as the render pad so columns blend.
  ctx.fillStyle = PAD_RGB;
  ctx.fillRect(0, 0, SIDE_TOTAL_W, SIDE_TOTAL_H);

  // Labels: "Before" left, "After" right. White on the gray.
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 36px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Before", SIDE_COL_W / 2, SIDE_PAD_TOP / 2);
  ctx.fillText("After", SIDE_COL_W + SIDE_COL_W / 2, SIDE_PAD_TOP / 2);

  // Columns.
  drawContain(ctx, before, 0, SIDE_PAD_TOP, SIDE_COL_W, SIDE_COL_H);
  drawContain(
    ctx,
    after,
    SIDE_COL_W,
    SIDE_PAD_TOP,
    SIDE_COL_W,
    SIDE_COL_H
  );

  // Bottom mark.
  ctx.font = "500 24px Georgia, serif";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(
    "askmai.co",
    SIDE_TOTAL_W / 2,
    SIDE_PAD_TOP + SIDE_COL_H + SIDE_PAD_BOTTOM / 2
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      "image/png"
    );
  });
}

/**
 * Pick the best MIME the browser will record. Order matters:
 * Safari supports mp4 natively which is what TikTok/Reels expect;
 * Chrome/Firefox fall back to webm which Web Share API still
 * accepts on most surfaces.
 */
function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  const candidates = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const m of candidates) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

export function recorderMimeAvailable(): boolean {
  return Boolean(pickRecorderMime());
}

/**
 * Render the wipe transition into a video Blob. Sequence inside
 * REVEAL_TOTAL_MS: hold-before -> wipe -> hold-after. Both before
 * and after are contain-fit into the 9:16 canvas with the same
 * mid-gray pad as the server-side render.
 *
 * Pure client work; no server round-trip. Latency is roughly the
 * REVEAL_TOTAL_MS itself (we can't capture faster than realtime
 * because MediaRecorder pulls frames from the live canvas stream).
 */
export async function composeRevealVideo(
  beforeUrl: string,
  afterUrl: string
): Promise<Blob> {
  const mime = pickRecorderMime();
  if (!mime) {
    throw new Error("MediaRecorder not available in this browser");
  }
  const [before, after] = await Promise.all([
    loadImage(beforeUrl),
    loadImage(afterUrl),
  ]);

  const canvas = document.createElement("canvas");
  canvas.width = VIDEO_W;
  canvas.height = VIDEO_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  const stream = canvas.captureStream(VIDEO_FPS);
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: 4_000_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  // Drive the canvas frames in lockstep with the recorder. We draw
  // continuously via requestAnimationFrame; the recorder samples at
  // VIDEO_FPS via captureStream.
  let startedAt = 0;
  let stopRaf = false;
  function frame(now: number) {
    if (stopRaf) return;
    if (!startedAt) startedAt = now;
    const t = now - startedAt;

    // Background pad.
    ctx!.fillStyle = PAD_RGB;
    ctx!.fillRect(0, 0, VIDEO_W, VIDEO_H);

    if (t < REVEAL_HOLD_BEFORE_MS) {
      drawContain(ctx!, before, 0, 0, VIDEO_W, VIDEO_H);
    } else if (t < REVEAL_HOLD_BEFORE_MS + REVEAL_WIPE_MS) {
      // Wipe: draw after first, then before clipped to a shrinking
      // left rectangle so the boundary line travels left-to-right.
      const wipeT = (t - REVEAL_HOLD_BEFORE_MS) / REVEAL_WIPE_MS;
      drawContain(ctx!, after, 0, 0, VIDEO_W, VIDEO_H);
      ctx!.save();
      const clipW = VIDEO_W * (1 - wipeT);
      if (clipW > 0) {
        ctx!.beginPath();
        ctx!.rect(0, 0, clipW, VIDEO_H);
        ctx!.clip();
        drawContain(ctx!, before, 0, 0, VIDEO_W, VIDEO_H);
        // Thin white wipe line at the boundary.
        ctx!.restore();
        ctx!.save();
        ctx!.fillStyle = "rgba(255,255,255,0.85)";
        ctx!.fillRect(clipW - 1.5, 0, 3, VIDEO_H);
      }
      ctx!.restore();
    } else {
      drawContain(ctx!, after, 0, 0, VIDEO_W, VIDEO_H);
    }

    if (t < REVEAL_TOTAL_MS) {
      requestAnimationFrame(frame);
    }
  }

  return new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      stopRaf = true;
      const blob = new Blob(chunks, { type: mime });
      if (blob.size === 0) {
        reject(new Error("MediaRecorder produced empty blob"));
        return;
      }
      resolve(blob);
    };
    recorder.onerror = (e) => {
      stopRaf = true;
      reject(new Error(`MediaRecorder error: ${String(e)}`));
    };
    recorder.start();
    requestAnimationFrame(frame);
    setTimeout(() => {
      try {
        recorder.stop();
      } catch {
        // already stopped
      }
    }, REVEAL_TOTAL_MS + 100);
  });
}
