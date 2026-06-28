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

### Recommendation: **A (extend SegFormer-B2)**

Reasoning:
- We're already paying for this call. ORing all classes except `Background` is a line of code and zero extra latency.
- The output is "polished catalog try-on," not photo-real matting. SegFormer-B2's edge quality is sufficient for catalog look (smaller flaws hide under the feather we already apply for the face mask).
- Zero new dependencies, zero new failure modes to handle.
- If a quality bar later requires better edges, **swap to RMBG-2.0 (option B) as a Phase-2 quality upgrade.** That's an isolated change behind the same segmentation interface; no other code moves.

**Open question for advisor:** is RMBG-2.0 edge quality so much better than SegFormer-B2 that it's worth the new provider integration upfront, vs. a clean "ship Phase 1 with B2, upgrade if needed"? My read is no, but advisor pressure-test welcome.

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

### Recommendation: **light gray #f0f0f0**

- Consistent with the existing pad color the renderer uses today, so the model already "knows" this background; no new bias.
- Works for both dark and light garments.
- Adjustable later (one constant) if Cass / Madison want a different look.

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

### Edge cases (must reject at upload, with clear UX)

| Case | Detection | UX |
|---|---|---|
| No face detected (back to camera, side profile) | Face+Hair mask empty | Reject: "We need to see your face for try-ons. Please upload a front-facing photo." |
| Multiple people in frame | Multiple connected components in the person mask, each >5% of canvas | Reject: "We can only render one person. Please upload a solo photo." |
| Feet not in frame (cropped at thighs/knees) | Bottom of person bbox is at `imageHeight - <threshold>` (i.e., person extends to bottom edge = likely cropped) | **Soft warn**, not reject. Normalize what we have but place feet "below canvas" so head still lands at target position. Mark with a `partial_body` flag so the user knows. |
| Person too small (zoomed out, < 30% of canvas) | Person bbox height < 30% of source height | Soft warn but proceed (scaling up loses detail, but it'll still work). |
| Pure white / pure black background already | Person mask coverage >99% (model thinks everything is person) | Reject: "We couldn't detect you in this photo. Please try a photo with more contrast against the background." |

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

**Storage shape:** new column on `public.users` called `tryon_geometry JSONB`. Versioned: `{ version: 1, head_bbox: {...}, person_bbox: {...}, feet_y, partial_body, canvas_dims: [1024,1536] }`. One column, one read, no extra table.

**Open question for advisor:** the alternative is a sidecar JSON file in the bucket (e.g., `<userId>/<uuid>.geom.json` alongside the image). Sidecar wins if we ever want to inspect the geometry without touching the DB; JSONB column wins for atomic updates. I lean column; advisor pressure-test welcome.

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

## Open questions for the pressure test

1. **Canvas color.** Light gray (#f0f0f0) is my pick. Black or pure white are valid alternatives. Cass / Madison aesthetic input would help.
2. **RMBG-2.0 upfront vs SegFormer-B2.** Is the edge-quality delta on hair flyaways big enough to justify a new provider integration in v1?
3. **Geometry storage.** JSONB column on `users` vs sidecar JSON file in the bucket. I lean column for atomic updates; sidecar wins for "inspect without DB."
4. **Upload UX wait.** Block the upload with a "we're optimizing your photo" indicator (~10 s), or accept instantly and run normalization in the background blocking only the first render?
5. **Reject-at-upload thresholds.** What's the bar for "no face detected" vs "we'll try anyway"? Strict (any face below 80% confidence rejected) keeps quality high; lenient (try anything that has SOME face) reduces friction. My instinct is lenient + a `quality_warning` flag the user can dismiss.
6. **Garment reference normalization.** Worth standardizing the garment-side cutout scale too in this branch, or save for a follow-up?

---

## Out of scope for this branch

- Replacing gpt-image-1 with a different model (Imagen 3, Replicate's IDM-VTON, etc.).
- The viral share / Phase 3 referral loop.
- Anthropic prompt caching on the chat system prompt.
- Any chat / grid / homepage / forcreators surface.
- Per-creator render style tuning (e.g., Cass's renders feel different from Madison's).
