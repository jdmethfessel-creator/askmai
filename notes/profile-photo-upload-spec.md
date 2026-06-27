# Profile + Photo Upload — Spec & Required Safety Layer

> **Status (2026-06-27):** No code. This is a written spec for the
> profile page + photo upload flow with the safety scaffolding
> spelled out. **The 18+ age gate is a hard prerequisite, not an
> afterthought.** No image-accepting code should ship until the gate
> is explicitly designed and reviewed.

## Profile page

### Fields

| Field | Type | Required | Stored where | Why |
|---|---|---|---|---|
| Display name | text | yes | `users.display_name` (new col) | Greeting in chat + welcome message |
| Avatar | optional photo | no | Supabase Storage `avatars/<uid>.jpg`, signed URL only | Visual personalization in chat header |
| Creators followed | multi-select | no | `user_creator_follows` (new table, FK to creators) | Powers "all your twins in one place" if/when we expand past 1 |
| Body photo (try-on) | photo (gated, see below) | no | Supabase Storage `tryon-photos/<uid>/<uuid>.jpg`, signed URL only | Renders |
| Age verified | boolean | yes (gated below) | `users.age_verified_at` (new TIMESTAMPTZ) | Hard gate for any photo upload |

`display_name` is the only required field. Everything else is opt-in
and individually deletable. "Creators followed" defaults to whichever
creator's page they signed up from (typically `madisonwaller` for
v1).

### Layout (informational, not pixel-perfect)

```
PROFILE
─────────────────────────────────────
[avatar]  Your name  [ Display name input ]
          Email      jd.methfessel@gmail.com (read-only)

CREATORS YOU FOLLOW
─────────────────────────────────────
☑ Madison Waller
☐ (more when available)

TRY-ON PHOTOS                                      [+ add]
─────────────────────────────────────
[ thumbnail ] uploaded 2026-06-26  [delete]
[ thumbnail ] uploaded 2026-06-21  [delete]
( Drag and drop or browse to upload )

      ⚠  This requires age verification — see below.

ACCOUNT
─────────────────────────────────────
[ Delete all my data ]
```

A "Delete all my data" button at the bottom is non-negotiable for
photo-handling features (GDPR / CCPA hygiene, and creators will ask
about it in onboarding diligence).

## Photo upload — REQUIRED SAFETY LAYER

A photo of a real person is the strictest class of user-generated
content this product accepts. Three independent layers must all be in
place before any byte of image data hits Supabase Storage:

1. **Age verification gate** — runs BEFORE the file picker opens.
2. **Explicit consent capture** — runs WITH the upload submission.
3. **Storage / retention / delete posture** — defined BEFORE the
   first upload.

### Layer 1 — Age verification gate

**Goal**: prevent a minor from ever uploading a body photo, period.

**Where the gate sits**: **between the "+ add" button click and any
file picker open.** Not after the upload, not as a checkbox on the
upload form — *before the picker dialog opens*.

```
[+ add] click
   ↓
Modal: AGE VERIFICATION
   • "You must be 18+ to upload a photo."
   • Date-of-birth input (MM / DD / YYYY)
   • Confirm button (disabled until DOB ≥ 18 years ago)
   • Cancel button (closes modal, no upload)
   ↓
If DOB confirms 18+ → set users.age_verified_at = now() and
                      OPEN the file picker
If DOB is < 18      → modal closes with "We're sorry — AskMai's
                      photo features are only available to users 18
                      and older." No record of attempt is stored
                      beyond a single anonymous metric increment
                      (`underage_blocks_total` — counter only, no
                      DOB).
```

**Critical implementation rules**:

- The age check is **server-side**. The client computes a preview
  state but the actual gate is at `/api/profile/age-verify` which
  receives the DOB and either accepts (writes `age_verified_at`) or
  rejects (returns 403, no row write).
- **Once verified, the gate is bypassed for the same user on
  subsequent uploads** (we don't re-prompt — the row stamp is the
  proof). But the user can revoke verification by deleting their
  account.
- We do **NOT** store the date of birth itself. We store only the
  derived boolean `age_verified_at` (a timestamp confirming age
  ≥18 at that moment). The raw DOB is dropped after the
  comparison. Storing DOB invites compliance burden (CCPA "right
  to know what we have") that we don't need to take on.
- A user under 18 who tries to bypass the gate by lying about DOB
  is on them — but our log + audit trail must show we asked, and
  our T&C must say the false DOB is a breach. (Separate legal doc;
  flag to discuss with counsel.)

### Layer 2 — Explicit consent at upload

**Where it sits**: on the upload form itself, alongside the file
picker UI.

```
TRY-ON PHOTO UPLOAD

[ Drop photo here or browse ]

[ ] I confirm this is a photo of ME (the account holder), not
    anyone else, and I am 18 or older.

[ ] I understand this photo will be used only to generate try-on
    images that I see in my own account. It will NOT be used to
    train any AI model, NOT shared with other users, NOT shared
    with the creators on AskMai, and NOT used in any marketing
    surface.

[ ] I can delete this photo at any time from my profile, and all
    generated try-on images derived from it will be deleted at the
    same time.

[ Upload photo ]   (disabled until all 3 checkboxes are checked)
```

**Critical implementation rules**:

- All three checkboxes start unchecked. None pre-checked, ever.
- Submit button is disabled until all three are checked AND a file
  is selected.
- On submit, the route stores `consent_acknowledged_at` alongside
  the photo row. (`tryon_photos` table: `id`, `user_id`, `storage_key`,
  `mime_type`, `size_bytes`, `consent_acknowledged_at`,
  `age_verified_at_snapshot`, `created_at`, `deleted_at`.)
- The consent language is **explicit about NEGATIVE space**: NOT
  shared with creators, NOT used for training, NOT marketing. The
  default interpretation should be "this is private to me."

### Layer 3 — Storage / retention / delete

**Storage location**: Supabase Storage bucket `tryon-photos` with
private ACL. No public URLs. Photos accessed only via short-lived
signed URLs (≤5 min) generated server-side when the user views their
own profile.

**Key naming**: `tryon-photos/<user_id>/<uuid>.<ext>`. User ID in
path lets us enforce ownership at the storage policy level (row-
level security on storage).

**File limits**:

| Constraint | Limit | Why |
|---|---|---|
| MIME type | jpeg / png / webp / heic only | Avoid SVG injection, animated GIF surprises |
| Max size | 8 MB | Big enough for a phone photo, small enough to bound cost |
| Server-side MIME sniff | required | Don't trust the client-supplied content-type |
| Dimensions | min 512×512, max 4096×4096 | Below = too low quality for try-on; above = wasteful |
| Per-user upload count | max 3 active | Forces deletion-on-replace, caps storage cost |

**Retention**:

- Default retention: **indefinite** while the user account exists,
  with the explicit user-controlled delete.
- Auto-purge on account deletion: when a `users` row is deleted (via
  the "Delete all my data" button), all rows in `tryon_photos` are
  also deleted AND the storage objects under their `user_id` prefix
  are removed. Single transaction; failure = entire delete is
  rolled back so we don't leave orphan photos with no DB record.
- Generated try-on outputs (renders made FROM the body photo) are
  also tagged with the source photo's id and cascade-deleted when
  the source is deleted. The user's UI shows the link
  ("Generated from photo uploaded 2026-06-26") so they understand
  what disappears.

**Access**:

- Only the photo owner can read their photos (signed URL generation
  is gated by `userId === session.userId` server-side).
- Creators can never see user photos. Not in the dashboard, not in
  any export, not in logs. Photos are never sent to Anthropic in a
  chat context. The only outbound use is the render API.
- Renders ARE sent to OpenAI per render call. OpenAI's data
  retention policy applies to the input image; with their zero-
  retention setting enabled, the photo isn't retained on their
  side. **Make sure zero-data-retention is enabled on the OpenAI
  API key before any photo upload ships.** Default is 30-day
  retention; this is a one-time account-level toggle.

**Delete (user-initiated)**:

- "Delete this photo" button on each photo thumbnail in the profile.
- Confirmation dialog: "Delete this photo? Try-on images generated
  from it will also be deleted. This can't be undone."
- On confirm, route deletes the storage object + the DB row + any
  cascade-linked render records. The user sees the photo + renders
  vanish from the UI immediately (optimistic UI is fine since the
  delete is the only operation that touches state here).

### Where the safety layer sits in code (high level, not prescriptive)

```
/profile  (page, server component)
   ↓
 [+ add try-on photo]  (client button)
   ↓
 <AgeGateModal />  (client modal, MOUNTED but hidden by default)
   ↓
 POST /api/profile/age-verify  (server route — writes age_verified_at)
   ↓ (only if 200)
 <PhotoUploadForm />  (file picker + 3 consent checkboxes)
   ↓
 POST /api/profile/tryon-upload  (multipart, gated on session +
                                  age_verified_at + consent flags)
   ↓
 Supabase Storage put + tryon_photos row insert (in transaction)
   ↓
 Refresh profile UI
```

The **route for age-verify is separate from the route for upload**.
Conflating them invites the bug where a successful upload skips the
age check (e.g. if the upload route runs the gate AFTER processing
the file, a leaked tmp file is a real concern). Keep them
independent.

## Open questions to resolve before building

1. **Geographic compliance**: do we need to block uploads from EU
   without an explicit GDPR consent flow on top of the in-product
   consent? (Probably yes if we get EU signups; defer until then.)
2. **Photo content moderation**: do we run an OpenAI moderation
   API call on every upload? Cost is small but failures and false
   positives are real. Recommend yes for v1 — reject any photo
   classified as adult, violent, or otherwise unsuitable per
   OpenAI's moderation tags. Block at upload time, don't surface to
   the user that "moderation" happened (just a generic "couldn't
   process this photo" message).
3. **Creator visibility**: are creators ever shown aggregate stats
   like "120 users uploaded a body photo this week"? If yes, the
   creator dashboard touches the count but never the photos
   themselves.
4. **Re-verification cadence**: if a user verified at 17:11 today,
   they're 18+ tomorrow. The `age_verified_at` is a *moment-in-time*
   snapshot. If they delete their account and re-create, they
   re-verify. Should be enough; no scheduled re-prompts.
5. **Photo upload during signup**: explicitly DO NOT couple photo
   upload with the signup flow. Photo upload should be a separate,
   intentional action from a verified-account profile page. Never
   "upload a photo to finish signing up."

## Recommended build order (when we get there)

1. `users` schema migration: add `display_name`, `age_verified_at`.
2. Profile page server component skeleton (name only, no photo).
3. Age-verify route + AgeGateModal.
4. Storage bucket policy + signed-URL helpers (no UI yet).
5. Upload route with full validation chain (server-side MIME
   sniff, size cap, ownership check).
6. Upload form UI with the three consent checkboxes.
7. Photo list + delete in profile UI.
8. Render pipeline integration (separate from photo upload, calls
   OpenAI with the stored photo).
9. Account-deletion cascade.
10. Moderation API on upload.

Each step ships independently. No step accepts a real photo until
step 5 lands AND age-verify works AND the moderation pipeline works
in dev.

## What this doc deliberately doesn't decide

- Exact font / spacing / copy of the consent checkboxes (UX polish
  pass).
- Whether age-verification needs a third-party provider (Veriff,
  Persona) or self-attestation is enough. v1 = self-attestation, but
  flag for legal review.
- Whether to require email re-confirmation before each photo
  delete (unnecessary friction; skip for v1).
- The render endpoint design itself — that's covered in the
  `render-feature-economics.md` doc.

The point of this doc is: **here is the safety scaffold**. Build the
scaffold first, then everything else clips into it.
