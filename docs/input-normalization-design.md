# Try-on input normalization: design

Status: **design draft, no implementation**. To be pressure-tested by an external advisor before greenlight.

Branch: `feat/jd-input-normalization`. The live `/api/render` path is not touched until the design is locked.

---

## Problem

We currently hand gpt-image-1 the user's raw photo (whatever they uploaded: any aspect, any pose, any crop, any background, any lighting). The model treats this as "regenerate this scene with new clothes," not "dress this controlled figure." Consequences observed in production logs:

- Body proportions land wrong (different stance, different camera angle, head shifts vertically by 100+ px).
- The background gets regenerated, often hallucinated (a restaurant, a beach, etc.).
- The post-hoc face composite + reposition logic patches the symptom, not the cause; even when it works, the body underneath is invented.
- One concrete example from our diagnostics: JD's stored photo is 468×1274 (aspect 0.367), and the existing `fit:contain` normalization pillars it into 1024×1536 with 460 px of gray padding on the sides. The model sees a thin person in a wide gray frame and "fills in" the empty space.

Goal: every photo reaching gpt-image-1 is **an isolated person on a clean neutral canvas at a fixed known position, scale, and aspect.** The model's job becomes "swap the clothing on this controlled figure"; everything else is locked.

Target aesthetic: **polished catalog try-on visualization**, not candid photo. Consistent, predictable, clean. The bar is "looks like a Net-a-Porter product photo with a different garment," not "looks like the photo I just took."

---

## 1. Person segmentation

### What we have today

`src/lib/segmentClothing.ts` already calls `mattmdjaga/segformer_b2_clothes` on HuggingFace's Inference Providers router (`hf-inference` provider). The model returns 18 ATR classes with per-class masks:

```
Background, Hat, Hair, Sunglasses, Upper-clothes, Skirt, Pants, Dress, Belt,
Left-shoe, Right-shoe, Face, Left-leg, Right-leg, Left-arm, Right-arm, Bag, Scarf
```

We OR a subset of these for the editable clothing mask (Upper-clothes, Skirt, Pants, Dress, Belt, Scarf) and another subset for the head mask (Face, Hair). The other classes are returned in the same response and currently ignored.

### Options

| Option | Source | Cost / image | Latency | Edge quality | Complexity |
|---|---|---|---|---|---|
| **A. Reuse SegFormer-B2, OR all non-Background classes** | Existing HF call | $0 extra (same call we already pay) | $0 extra (~2–4 s, same call) | Good for body silhouette; coarse on hair flyaways | None — already in our code |
| B. RMBG-2.0 (Bria) via Fal-AI | New provider integration | ~$0.005–0.01 | ~3–5 s | Excellent (designed for matting) | Medium: new provider, key, error handling |
| C. Replicate `rembg` | Replicate API | ~$0.002 ($0.0023/sec × ~1 s) | ~5–10 s | Very good, common production choice | Medium: new dependency + key |
| D. `briaai/RMBG-1.4` ONNX, run locally via `@huggingface/transformers` | Bundled in lambda | $0 per call | ~5–15 s on CPU | Very good | High: model weights add ~80 MB to deploy, cold-start grows |
| E. MediaPipe Selfie Segmentation, browser-side | Browser | $0 | ~1 s on client | Good for portraits, varies by device | High: client-side dependency, results differ across devices |

### Recommendation: **A (extend SegFormer-B2)** — CONFIRMED by advisor

Reasoning:
- We're already paying for this call. ORing all classes except `Background` is a line of code and zero extra latency.
- The output is "polished catalog try-on," not photo-real matting. SegFormer-B2's edge quality is sufficient for catalog look (smaller flaws hide under the feather we already apply for the face mask).
- Zero new dependencies, zero new failure modes to handle.
- **RMBG-2.0 is noted as a v2 edge-quality lever.** Don't block Phase 1 on it. Swap-in is isolated behind the same segmentation interface; no other code moves when we upgrade.

---

## 2. Background removal + neutral canvas

Once we have a person mask (binary, person=255, background=0), the rest is pure pixel ops via `sharp` — no new model.

### Steps

1. **Refine the mask edge.** The raw SegFormer mask is hard-thresholded at 127. Apply a small Gaussian blur (sigma 2–3 px) before using it as alpha, so the cutout doesn't look like a paper-cutout sticker.
2. **Build the person-only RGBA.** Take the original RGB, attach the feathered mask as alpha.
3. **Composite onto the neutral canvas.** A solid 1024×1536 background, RGB only, composited with the person RGBA on top.
4. **Encode as PNG** (preserves the alpha-edge softness and the gray background without JPEG ringing).

### Neutral canvas color

| Color | Pros | Cons |
|---|---|---|
| Pure black (#000) | Strongest "catalog" look; products pop | Dark garments lose silhouette contrast |
| Pure white (#fff) | Brightest studio look | White garments blow out at boundary |
| **Light gray (#f0f0f0 or #f5f5f5)** | Neutral, doesn't fight any garment color; matches existing `fit:contain` pad color | Slightly less editorial |

### Recommendation: **mid-neutral gray (#909090, in the #888–#999 band)** (REVISED per advisor)

- Original draft proposed #f0f0f0 (matching the existing pad color), but JD called the right shot: gpt-image-1 infers BODY LIGHTING from background tone. Light gray blows out the body; black crushes / moodies it (this is what was producing the "bar lighting" hallucinations on Cass's renders).
- Mid-neutral gray sits at the perceptual middle and produces even, neutral light on the subject — the standard backdrop convention in lookbook / e-comm photography for exactly this reason.
- Stored as a single tunable constant (`NORMALIZED_CANVAS_COLOR = "#909090"`) so it's a one-line dial if Cass / Madison push for a slightly different shade later.
- The existing `fit:contain` pad color (#f5f5f5) stays separate — it's only used on the legacy render path, which is being replaced.

### Shadow / floor

Skip in Phase 1. A clean cutout on flat gray looks "clean catalog," which is the target. If renders look "floaty," add a soft drop shadow at the feet in Phase 2 (one sharp.composite of a pre-baked ellipse). Not load-bearing.

**Open question for advisor:** is "floaty" actually a problem? Some catalogs (Reformation, Khaite) explicitly show no shadow. If we never add a shadow we ship faster.

---

## 3. Normalization: scale + position

The goal: every normalized image has the user's head at a known position, body centered horizontally, feet at a known position, body at a consistent scale.

### Detection

From the existing SegFormer call (no extra inference):

- **Person bbox**: tight bbox over the OR'd "all non-Background" mask.
- **Head bbox**: existing Face+Hair mask (already computed).
- **Feet location**: bottom edge of the person mask (lowest non-zero row).
- **Body center x**: median x of person-mask pixels (more robust to one-arm-out poses than the bbox-center x).

### Canonical layout (1024×1536 canvas)

Standard catalog full-body composition:

```
y =    0   ┌──────────────────────┐
           │   gray background     │
y =   100  │     ┌──top of head    │  ← 6.5% from top
           │     │                 │
           │     │     person      │  ← target person height ~1350 px
           │     │   (head-to-     │     (88% of canvas height)
           │     │    feet)        │
           │     │                 │
y =  1450  │     └──feet           │
           │                       │
y =  1536  └──────────────────────┘  ← 6% floor room

         x = 0     x = 512     x = 1024
              center body horizontally on x = 512
```

### Math

Given source person bbox `(px, py, pw, ph)`:

```
heightScale = TARGET_PERSON_HEIGHT_PX / ph     // e.g. 1350 / ph
widthScale  = (CANVAS_W * 0.96)   / pw          // cap to ~96% of canvas width
scale       = min(heightScale, widthScale)      // never let person extend off sides

scaledW     = pw * scale
scaledH     = ph * scale
offsetX     = (CANVAS_W - scaledW) / 2          // center horizontally
offsetY     = TARGET_HEAD_TOP_Y                 // anchor top of head, not center
```

Person sharp-extract + resize via `scale`, then composite at `(offsetX, offsetY)` onto the gray canvas.

### Edge cases — strictness REVISED per advisor

The bar: hard-reject ONLY the two cases that break normalization itself; everything else warns and proceeds. Render quality is allowed to degrade gracefully under bad-input conditions; we don't gatekeep on perfection.

| Case | Detection | UX |
|---|---|---|
| **No person detected** | Person mask coverage < 3% of canvas (segmentation found basically nothing) | **HARD REJECT**: "We couldn't find you in this photo. Try one with more contrast between you and the background." |
| **Multiple people in frame** | ≥2 connected components in the person mask each >5% of canvas | **HARD REJECT**: "We can only render one person. Please upload a solo photo." |
| No face detected (back to camera, side profile) | Face+Hair mask empty | Warn + proceed. Renders without a face will probably look bad; user finds out and can re-upload. Don't gate. |
| Feet not in frame (cropped at thighs/knees/waist) | Bottom of person bbox at `srcHeight - <threshold>` (person extends to bottom edge ≡ likely cropped) | Warn + proceed. **See "Scale math for partial-body inputs" below** — this is the critical-path case. |
| Person too small (< 30% of source height) | Person bbox height < 30% of source height | Warn + proceed. Scaling up loses detail but works. |
| Pure-color background (model thinks everything is person) | Person mask coverage > 99% | Warn + proceed. The grayscale composite will be near-identical to the input. |

### Scale math for partial-body inputs (CRITICAL PATH)

The base case is easy: feet detected → scale by head-to-feet height → place head top at y=100, feet at y=1450. Most real uploads aren't this. Most real uploads are cropped at the shin, knee, hip, or waist. If we naively scale a half-body crop to "fill head→feet," we blow the figure up to 2× true size and the proportions look wrong (the very thing producing the body-proportion artifacts we're killing).

The rule: **never fake the missing part of the body.** Scale by what we can measure; let the visible body land wherever it lands; mark `partial_body=true` so downstream code knows.

#### Anchor ladder (use the first one that's satisfied)

| Anchor | Condition | Math | When this fires |
|---|---|---|---|
| **A. Head-to-feet** | Feet detected (bottom of person mask < srcHeight − 10 px) AND face detected | `scale = TARGET_PERSON_HEIGHT_PX / personBbox.h` (target = 1350 px) | Full-body shot, the ideal input |
| **B. Head-to-knee or head-to-hip** | At least one leg class (`Left-leg` / `Right-leg`) present AND face detected. Hip y ≈ top of leg-class mask | `scale = TARGET_HEAD_TO_HIP_PX / (hipY − headTopY)` (target head-to-hip ≈ 765 px, ~50% of canvas) | Cropped below the knee (most common real upload) |
| **C. Head size only** | Face detected, no usable lower-body landmarks | `scale = TARGET_HEAD_HEIGHT_PX / headBbox.h` (target = 215 px, ≈ 1/7 of figure per classical 7-head proportion rule) | Waist-up crop / "selfie" |
| **D. Reject** | No face AND no person bbox usable | Hard-reject (already covered above) | — |

#### Positioning post-scale

Once `scale` is chosen:

```
scaledHeadTop  = headBbox.y * scale   // y of head top within the resized person
offsetY        = TARGET_HEAD_TOP_Y - scaledHeadTop   // pin head top to y=100
offsetX        = (CANVAS_W / 2) - (personCenterX * scale)   // center body on x=512
```

**Critically:** do NOT clamp `offsetY` to keep the body inside the canvas. If a half-body crop scales to a person who only fills the top half of the canvas, that's correct — we leave the bottom half as gray backdrop and mark `partial_body=true`. **Stretching a knee-cropped photo to "fake feet at y=1450" is exactly the failure mode producing the wrong-proportions complaint.**

#### Storing what we measured

The `tryon_geometry.partial_body` flag tells the render pipeline whether to expect a half-body result. Two downstream uses:
1. The face composite's alignment classifier can tighten the SCALE-rejection threshold for partial-body inputs (less tolerance for the model resizing the head, because there are fewer landmarks to anchor against).
2. The prompt can include "the figure may extend partially out of frame; do not fabricate the missing body parts" to keep gpt-image-1 from inventing legs.

#### What this changes about the model's output

With partial-body inputs handled honestly, the model sees: figure-on-gray, body proportions correct for the visible portion, no awkward scaling that signals "fix me." The hallucination risk drops because there's no proportional inconsistency for the model to try to "correct."

### Storing the geometry lock

After normalization, store the canonical metadata so render-time doesn't have to re-derive it:

| Field | Type | Purpose |
|---|---|---|
| `head_bbox` | `{ x, y, w, h }` | Where the head lives in the canonical canvas. Read by the post-hoc face composite. |
| `person_bbox` | `{ x, y, w, h }` | Person extent. Useful for future tweaks (e.g., garment scaling against torso width). |
| `feet_y` | `number \| null` | Bottom of feet, or null if `partial_body`. |
| `partial_body` | `boolean` | True if feet were cropped from the source. |
| `canvas_dims` | `[1024, 1536]` | Snapshotted in case we change defaults later. |
| `normalized_at` | timestamp | For migration ("re-normalize anyone with metadata older than X"). |
| `normalization_version` | int | Bump when the algorithm changes; lets a migration find stale files. |

**Storage shape:** new column on `public.users` called `tryon_geometry JSONB` — CONFIRMED. Versioned: `{ version: 1, head_bbox: {...}, person_bbox: {...}, feet_y, partial_body, canvas_dims: [1024,1536] }`. One column, one read, no extra table.

---

## 4. Where this runs: upload time vs render time

### Upload time

| Pros | Cons |
|---|---|
| One-time cost: segmentation + normalization paid once per upload, not per render | Upload latency goes from instant (~500 ms) to seconds (~5–15 s) |
| Storage is the canonical normalized version; renders are dumb pass-through reads | Can't iterate on normalization without re-uploading |
| Reject at upload (bad photo) saves render-time disappointment + render credit | If we change the canonical layout, existing users have stale files |
| Geometry metadata is pre-computed; render reads it from JSONB | Cold-start cost (sharp + HF) hits every upload |
| Render path latency stays in the gpt-image-1 budget |  |

### Render time

| Pros | Cons |
|---|---|
| Upload stays fast (~500 ms) | Every render pays the ~5–10 s normalization extra |
| Iteration on normalization is automatic (next render uses new logic) | Original file stays on disk forever (storage cost) |
| Original file preserved, available for any future re-processing | Wasted compute on 2nd / 3rd / Nth render of the same person |
|  | Geometry not pre-computed; have to re-derive every render |

### Recommendation: **upload time, with the ORIGINAL preserved**

New bucket layout:

```
tryon-photos/
  <userId>/<uuid>.normalized.png    ← canonical, fed to renders
  <userId>/<uuid>.original.<ext>    ← preserved for re-normalization
```

`users.tryon_photo_path` points at the `.normalized.png` (drop-in for existing render code, which reads from this column). New `users.tryon_original_path` and `users.tryon_geometry` columns capture the rest.

Why this wins:
- Users upload rarely (once, maybe a few times); they render often. Pay once, save every render.
- Iteration safety: if we ship a v2 normalization algorithm, a one-shot migration script reads everyone's original, re-normalizes, updates the canonical + geometry, bumps the version. Users don't have to do anything.
- Reject-at-upload is the cleaner UX: users find out their photo isn't usable BEFORE they tap Try-On, not after the render credits are spent.

**Migration of existing users:** one-time job that reads everyone's current `tryon_photo_path` (which IS their original today, untouched), runs normalization, writes the new canonical + geometry, swaps `tryon_photo_path` to the new file. Backward-compatible; current renders keep working through the swap because the render code is the same `read users.tryon_photo_path` step.

**Open question for advisor:** is the ~10 s upload wait acceptable UX? Alternatives: (a) show a progress indicator + "Hold on, optimizing your photo…" UI; (b) accept the upload immediately and run normalization in the background, blocking the FIRST render until normalization completes. (b) hides the wait but introduces a "your first render is slow" surprise. I'd take (a). Advisor view welcome.

---

## 5. Interaction with existing face composite

The current pipeline does this (in `src/lib/render.ts`):

1. SegFormer the input photo → editable clothing mask + head bbox
2. gpt-image-1 inpaint with that mask
3. SegFormer the OUTPUT → new head bbox
4. Classify input vs output head bbox: aligned / translate / scale / skip
5. Composite the user's face/hair pixels onto the output via the classifier branch
6. Apply branding overlay

### After input normalization

- **Step 1 is partially pre-computed.** The head bbox is already in `tryon_geometry`. The clothing mask still has to be computed per render (the model needs the mask in OpenAI's format, and we don't store that). But we can skip the input-image SegFormer call IF we re-segment the normalized file instead — which is essentially the same call we'd have done, just on a cleaner input. Net: ~0 latency change for step 1.
- **Step 2 still runs.** gpt-image-1 might still move the head; we still need to check.
- **Step 3 (alignment classifier) STAYS, but should mostly route ALIGNED.** With a controlled input the model has far less reason to recompose the body. Expectation: the SCALE branch becomes rare; the TRANSLATE branch becomes rare; SKIP should approach zero. The classifier is now a safety net, not the main path.
- **Step 4 (face composite) STAYS.** Still needed; gpt-image-1 will still hallucinate face details. The seam (current downward-dilation + feather) should produce a much cleaner result because the AI-generated neck/upper-chest skin tone will be more predictable on a controlled input.

### What goes away

Nothing fundamental disappears. The face composite, alignment classifier, and seam blend all stay as safety nets. They just stop carrying load on every render.

### What might be tunable down

If renders are reliably ALIGNED after normalization, we can probably:
- Reduce the downward-dilation constant (currently 30 px) since the seam is less of a problem.
- Tighten the alignment tolerance back to ~5% center shift (currently 8%) since the model should rarely violate it.

But: don't tune these in the same commit as normalization. Ship normalization, observe a week of prod renders, then tune.

---

## 6. Effect on the gpt-image-1 prompt

Current `RENDER_PROMPT` (in `src/lib/render.ts`) tells the model to "swap clothing… preserve face, hair, hands, feet, background opaque." Most of those constraints are defensive against the model's freedom to regenerate everything.

After normalization, the constraint set simplifies:

| Prompt directive | Pre-normalization | Post-normalization |
|---|---|---|
| "Preserve background" | Critical (model invents scenes) | Mostly redundant (background is uniform gray; model can regenerate it identically) |
| "Preserve face / hair" | Critical | Still useful (model still re-stylizes); the mask shape is what enforces it but the prompt reinforces |
| "Preserve hands / feet" | Critical | Still useful; the mask is clothing-only |
| "Keep the figure in place" | Implicit, often violated | Reinforced — describe the figure as "on a neutral gray catalog backdrop" |
| New: "Render the new garment with realistic drape and shadows" | n/a | Worth adding — now that we control the input, we can ask for catalog-realism explicitly |

**Reference image side:** garment product images already go through `src/lib/removeBackground.ts` (SegFormer-B2 bg-remove). After normalization-on-the-person, we can ALSO standardize the GARMENT cutout scale (e.g., always center the garment in its reference image at a consistent size), so the model sees a clean garment on a clean canvas being asked to dress a clean figure on a clean canvas. All three inputs become controlled.

Recommendation: tune the prompt in a SEPARATE commit AFTER the normalization is live and we've watched 10–20 real renders. The prompt change has low risk but should be A/B'd against real input, not designed in the abstract.

---

## Recommended approach (single bundle)

| Phase | Scope | Estimate | Decision needed |
|---|---|---|---|
| **A. Core normalization (must-ship)** | Extend SegFormer call to OR person classes, build person cutout, composite on #f0f0f0 1024×1536 canvas, scale/center to canonical layout, store geometry JSONB on users row, add `tryon_original_path`, run normalization at upload-time, migrate existing users | 1.5–2 days | Go/no-go on the design as a whole |
| B. Upload-time rejection of bad inputs | Reject no-face / multi-person / bg-less inputs with clear UX copy | 0.5 day | Color of the rejection UX (modal? inline error?) |
| C. Render reads pre-computed geometry | Skip the input-image SegFormer call at render time; read head_bbox from `tryon_geometry`. Cuts ~3 s off every render | 0.5 day | None — pure follow-up after A lands |
| D. Prompt tuning | Update `RENDER_PROMPT` to match the controlled-input world | 0.25 day + A/B observation | Wait until A has run on prod for ~20 renders |

I'd ship A and B together (one branch, one merge). C and D land as follow-up commits once A is observed working on prod renders.

## Acceptance criteria (for Phase A)

- Upload a photo → stored file is exactly 1024×1536 PNG with neutral #f0f0f0 background, person centered horizontally, head top at y ≈ 100 px, feet at y ≈ 1450 px (or partial_body flagged).
- Existing `/api/render` calls work without code changes (drop-in: same `tryon_photo_path` column, same MIME, same dimensions the renderer already expects).
- Visual A/B: pick 3 user photos with known problem cases (the 0.367-aspect one, a photo with a busy restaurant background, a half-body crop), render each twice (current vs normalized), eyeball the difference. Acceptance: normalized renders should have NO hallucinated background, body proportions matching the original, no scene leakage.
- Renders show measurable shift in alignment log lines: ALIGNED rate should rise from current ~93% toward 99%.

## What I'm NOT proposing

- Replacing gpt-image-1 with a different model. The render call itself stays the same.
- Touching the chat app's render trigger flow. The chat's per-card and per-outfit Try-On buttons still post to `/api/render`; that endpoint behaves identically from the caller's POV (same input, same output shape).
- Pulling in a heavyweight matting model (RMBG-2.0, ONNX local) upfront. We can upgrade later if SegFormer-B2 edges aren't good enough; not before.
- Touching the alignment classifier or the seam logic. They become safety nets, not main path. Tuning them down is a separate later decision based on observed prod data.

## Decisions (closed)

1. **Canvas color** → mid-neutral gray `#909090` (in the #888–#999 band). Mid-gray gives even neutral light; light gray blows out, black crushes/moodies (which produced the bar-lighting hallucinations).
2. **Segmentation** → SegFormer-B2 (extend the existing call). RMBG-2.0 is noted as a v2 edge-quality lever; do not block on it.
3. **Geometry storage** → JSONB column on `users.tryon_geometry`.
4. **Upload UX** → BLOCK the upload (~10 s) with an "optimizing your photo" indicator. Do NOT background-normalize. Background-normalize means the user's first try-on (the highest-stakes one) runs on the un-normalized photo, the exact failure mode we're killing. Eat the latency at upload.
5. **Reject strictness** → lenient + warning EXCEPT hard-reject the two cases that break normalization itself: (a) no person detected; (b) multiple people. Everything else warns and proceeds.
6. **Garment-side normalization** → out of scope for this branch; follow-up.

## One-image proof gate (must pass before Phase A starts)

Before committing 1.5–2 days to Phase A, run the proposed pipeline manually on a single real-world test case and eyeball the result. If the render quality visibly jumps, proceed. If it doesn't, the architecture is wrong and we stop — no Phase A code.

**Test input**: JD's stored photo (the 468×1274, 0.367-aspect one already in `tryon-photos`). It's the same input that produced the restaurant-hallucination renders, so this is the highest-leverage A/B.

**Proof script** (lives at `scripts/normalize-proof/proof.mjs`):

1. Pull JD's photo from Supabase (`tryon-photos` bucket).
2. Call SegFormer-B2 on it once. OR all non-Background classes into a person mask. Capture head bbox, person bbox, feet-y, partial-body flag.
3. Apply the anchor-ladder scale logic (head-to-feet / head-to-hip / head-size). Resize person, composite onto a 1024×1536 mid-gray canvas with edge feather (~3 px).
4. Write the intermediate files to `scripts/normalize-proof/output/`:
   - `01-original.jpg` (the input as-stored)
   - `02-person-mask.png` (the binary person mask, for visual sanity)
   - `03-normalized.png` (the final 1024×1536 fed to gpt-image-1)
   - `04-geometry.json` (head_bbox, person_bbox, feet_y, partial_body, anchor_used)
5. Send `03-normalized.png` + one garment image (a clean catalog shot, e.g. one of Cass's Magda Butrym red dress images) to gpt-image-1 with the existing mask + render shape. Write the output to `05-render-normalized.png`.

**Cost**: one HF segmentation (~$0.001) + one gpt-image-1 render at medium (~$0.063) = **~$0.064 total**. One image, one render.

**Acceptance** (JD eyeballs):
- Does the normalized intermediate look like a clean isolated figure on neutral gray, with the head at roughly the top sixth and the body centered?
- Does the render show: no hallucinated scene background? Body proportions matching the original? Garment landing on the figure without weird drape? Face visibly recognizable?
- If YES → greenlight Phase A.
- If NO → stop and revisit the architecture before any more code.

---

## Out of scope for this branch

- Replacing gpt-image-1 with a different model (Imagen 3, Replicate's IDM-VTON, etc.).
- The viral share / Phase 3 referral loop.
- Anthropic prompt caching on the chat system prompt.
- Any chat / grid / homepage / forcreators surface.
- Per-creator render style tuning (e.g., Cass's renders feel different from Madison's).
