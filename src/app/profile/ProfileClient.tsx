"use client";

/**
 * Profile page client. Three sections:
 *   1. Display name (editable, inline save).
 *   2. Creators you follow (Phase 1 hardcodes Madison Waller).
 *   3. Try-on photo upload, gated by the 18+ age modal.
 *
 * The age gate sits BETWEEN the "+ add" button click and the file
 * picker. The picker is never invoked until POST /api/profile/age-
 * verify returns { verified: true } (server side check). The file
 * input is mounted but a ref triggers click() only after that 200.
 *
 * If the server returns { verified: false, blocked: true } we swap
 * the gate modal copy to a polite block and never open the picker.
 */

import Link from "next/link";
import { useRef, useState } from "react";

type Props = {
  email: string;
  initialDisplayName: string;
  ageVerified: boolean;
  photoUrl: string | null;
};

type GatePhase = "closed" | "asking" | "blocked";
type NameState = "idle" | "saving" | "saved" | "error";
type UploadState = "idle" | "uploading" | "uploaded" | "error";

const MAX_DISPLAY_NAME = 80;

export function ProfileClient({
  email,
  initialDisplayName,
  ageVerified,
  photoUrl,
}: Props) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [savedName, setSavedName] = useState(initialDisplayName);
  const [nameState, setNameState] = useState<NameState>("idle");
  const [nameError, setNameError] = useState<string | null>(null);

  const [verified, setVerified] = useState(ageVerified);
  const [gatePhase, setGatePhase] = useState<GatePhase>("closed");
  const [dob, setDob] = useState({ y: "", m: "", d: "" });
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  const [currentPhotoUrl, setCurrentPhotoUrl] = useState<string | null>(
    photoUrl
  );
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canSaveName =
    displayName.trim().length > 0 &&
    displayName.trim().length <= MAX_DISPLAY_NAME &&
    displayName.trim() !== savedName &&
    nameState !== "saving";

  async function saveDisplayName() {
    if (!canSaveName) return;
    setNameState("saving");
    setNameError(null);
    try {
      const r = await fetch("/api/profile/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: displayName.trim() }),
      });
      const data = (await r.json().catch(() => null)) as {
        ok?: boolean;
        display_name?: string;
        error?: string;
      } | null;
      if (!r.ok || !data?.ok || !data.display_name) {
        setNameState("error");
        setNameError(nameErrorMessage(data?.error));
        return;
      }
      setSavedName(data.display_name);
      setDisplayName(data.display_name);
      setNameState("saved");
      setTimeout(() => setNameState((s) => (s === "saved" ? "idle" : s)), 1800);
    } catch {
      setNameState("error");
      setNameError("Network blip. Try again?");
    }
  }

  // Click handler for the "+ add" / "Update photo" button. Opens the
  // gate modal if not already verified; otherwise opens the file
  // picker directly.
  function onAddPhotoClick() {
    if (verified) {
      fileInputRef.current?.click();
      return;
    }
    setGatePhase("asking");
    setDob({ y: "", m: "", d: "" });
    setGateError(null);
  }

  function dobValid(): boolean {
    const y = Number(dob.y);
    const m = Number(dob.m);
    const d = Number(dob.d);
    if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
      return false;
    }
    if (y < 1900 || y > new Date().getFullYear()) return false;
    if (m < 1 || m > 12) return false;
    if (d < 1 || d > 31) return false;
    return true;
  }

  async function submitAgeGate() {
    if (gateBusy || !dobValid()) return;
    setGateBusy(true);
    setGateError(null);
    try {
      const y = dob.y.padStart(4, "0");
      const m = dob.m.padStart(2, "0");
      const d = dob.d.padStart(2, "0");
      const r = await fetch("/api/profile/age-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dob: `${y}-${m}-${d}` }),
      });
      const data = (await r.json().catch(() => null)) as {
        verified?: boolean;
        blocked?: boolean;
        error?: string;
      } | null;
      if (!r.ok || !data) {
        setGateError("Something went wrong. Try again?");
        setGateBusy(false);
        return;
      }
      if (data.verified) {
        setVerified(true);
        setGatePhase("closed");
        setGateBusy(false);
        // Open the file picker now that the gate cleared.
        fileInputRef.current?.click();
        return;
      }
      if (data.blocked) {
        setGatePhase("blocked");
        setGateBusy(false);
        return;
      }
      setGateError(
        data.error === "invalid_dob"
          ? "That date does not look right."
          : "Something went wrong. Try again?"
      );
      setGateBusy(false);
    } catch {
      setGateError("Network blip. Try again?");
      setGateBusy(false);
    }
  }

  function closeGate() {
    setGatePhase("closed");
    setGateError(null);
    setGateBusy(false);
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file) return;
    setUploadState("uploading");
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await fetch("/api/profile/tryon-upload", {
        method: "POST",
        body: form,
      });
      const data = (await r.json().catch(() => null)) as {
        ok?: boolean;
        path?: string;
        error?: string;
        max?: number;
      } | null;
      if (!r.ok || !data?.ok) {
        setUploadState("error");
        setUploadError(uploadErrorMessage(data?.error, data?.max));
        return;
      }
      // Refresh the displayed photo by reloading the page. The server
      // generates a fresh signed URL on next render. A reload keeps
      // the signed-URL TTL story simple in Phase 1.
      setUploadState("uploaded");
      window.location.reload();
    } catch {
      setUploadState("error");
      setUploadError("Network blip. Try again?");
    }
  }

  return (
    <main className="profile-root">
      <div className="profile-inner">
        <h1 className="profile-h1">Profile</h1>

        <section className="profile-section">
          <h2 className="profile-h2">Your name</h2>
          <div className="profile-name-row">
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={MAX_DISPLAY_NAME}
              placeholder="How should we greet you?"
              className="profile-input"
              autoComplete="given-name"
            />
            <button
              type="button"
              onClick={saveDisplayName}
              disabled={!canSaveName}
              className="profile-btn profile-btn-primary"
            >
              {nameState === "saving" ? "Saving..." : "Save"}
            </button>
          </div>
          {nameState === "saved" && (
            <p className="profile-helper-success">Saved.</p>
          )}
          {nameState === "error" && nameError && (
            <p className="profile-helper-error">{nameError}</p>
          )}
          <p className="profile-helper">
            Email: <span className="profile-mono">{email}</span>
          </p>
        </section>

        <section className="profile-section">
          <h2 className="profile-h2">Creators you follow</h2>
          <ul className="profile-followlist">
            <li className="profile-followitem">
              <Link href="/madisonwaller" className="profile-followlink">
                <span className="profile-followname">Madison Waller</span>
                <span className="profile-followmeta">/madisonwaller</span>
                <span className="profile-followchevron" aria-hidden>
                  ›
                </span>
              </Link>
            </li>
          </ul>
        </section>

        <section className="profile-section">
          <h2 className="profile-h2">Try-on photo</h2>
          <p className="profile-helper">
            Upload a full-body photo of yourself. We use it only to
            generate try-on previews for items you ask about in chat.
            It is never shared with creators, never used to train any
            model, and you can delete it any time.
          </p>

          {currentPhotoUrl ? (
            <div className="profile-photo-wrap">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={currentPhotoUrl}
                alt="Your try-on photo"
                className="profile-photo"
              />
              <button
                type="button"
                onClick={onAddPhotoClick}
                disabled={uploadState === "uploading"}
                className="profile-btn profile-btn-ghost"
              >
                {uploadState === "uploading" ? "Uploading..." : "Replace photo"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onAddPhotoClick}
              disabled={uploadState === "uploading"}
              className="profile-btn profile-btn-primary profile-btn-block"
            >
              {uploadState === "uploading" ? "Uploading..." : "Add a photo"}
            </button>
          )}
          {uploadState === "error" && uploadError && (
            <p className="profile-helper-error">{uploadError}</p>
          )}

          {/* Hidden file input. Programmatically triggered only AFTER
              the age gate clears server side. */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic"
            onChange={onFileChosen}
            className="profile-file-hidden"
            aria-hidden
          />
        </section>
      </div>

      {gatePhase === "asking" && (
        <div className="profile-modal-backdrop" onClick={closeGate}>
          <div
            className="profile-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Age verification"
          >
            <button
              type="button"
              onClick={closeGate}
              aria-label="Close"
              className="profile-modal-close"
            >
              x
            </button>
            <h3 className="profile-modal-h3">Quick check</h3>
            <p className="profile-modal-sub">
              You need to be 18 or older to upload a photo. Enter your
              date of birth. We use it for this check only and do not
              store it.
            </p>
            {/* DOB inputs stacked with visible micro-labels. Order is
                locked to match the YYYY-MM-DD assembly in submitAgeGate:
                Month box -> dob.m, Day box -> dob.d, Year box -> dob.y.
                The string sent to /api/profile/age-verify is built as
                `${y}-${m}-${d}`, which the server splits on '-' as
                [year, month, day]. A July 1 1989 entry (M=07 D=01
                Y=1989) becomes "1989-07-01", never misread. */}
            <div className="profile-dob-row">
              <label className="profile-dob-field profile-dob-field-month">
                <span className="profile-dob-label">Month</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="MM"
                  maxLength={2}
                  value={dob.m}
                  onChange={(e) =>
                    setDob({ ...dob, m: e.target.value.replace(/\D/g, "") })
                  }
                  className="profile-input profile-dob-input"
                  aria-label="Month"
                />
              </label>
              <label className="profile-dob-field profile-dob-field-day">
                <span className="profile-dob-label">Day</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="DD"
                  maxLength={2}
                  value={dob.d}
                  onChange={(e) =>
                    setDob({ ...dob, d: e.target.value.replace(/\D/g, "") })
                  }
                  className="profile-input profile-dob-input"
                  aria-label="Day"
                />
              </label>
              <label className="profile-dob-field profile-dob-field-year">
                <span className="profile-dob-label">Year</span>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="YYYY"
                  maxLength={4}
                  value={dob.y}
                  onChange={(e) =>
                    setDob({ ...dob, y: e.target.value.replace(/\D/g, "") })
                  }
                  className="profile-input profile-dob-input"
                  aria-label="Year"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={submitAgeGate}
              disabled={!dobValid() || gateBusy}
              className="profile-btn profile-btn-primary profile-btn-block"
            >
              {gateBusy ? "Checking..." : "Confirm"}
            </button>
            {gateError && (
              <p className="profile-helper-error">{gateError}</p>
            )}
          </div>
        </div>
      )}

      {gatePhase === "blocked" && (
        <div className="profile-modal-backdrop" onClick={closeGate}>
          <div
            className="profile-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Photo upload unavailable"
          >
            <button
              type="button"
              onClick={closeGate}
              aria-label="Close"
              className="profile-modal-close"
            >
              x
            </button>
            <h3 className="profile-modal-h3">Sorry, not yet.</h3>
            <p className="profile-modal-sub">
              AskMai photo features are available to users 18 and older.
              The rest of the chat is open to you as usual.
            </p>
            <button
              type="button"
              onClick={closeGate}
              className="profile-btn profile-btn-primary profile-btn-block"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function nameErrorMessage(code: string | undefined): string {
  switch (code) {
    case "invalid_display_name":
      return "Names need to be 1 to 80 characters.";
    case "not_signed_in":
      return "Please sign in again.";
    default:
      return "Could not save. Try again?";
  }
}

function uploadErrorMessage(
  code: string | undefined,
  maxBytes: number | undefined
): string {
  switch (code) {
    case "age_not_verified":
      return "Verify your age before uploading a photo.";
    case "missing_file":
      return "Please choose a file.";
    case "file_too_large":
      return `That file is too large. Max ${
        maxBytes ? Math.round(maxBytes / 1024 / 1024) : 8
      } MB.`;
    case "invalid_file_type":
      return "Only JPEG, PNG, WebP, or HEIC photos work here.";
    case "not_signed_in":
      return "Please sign in again.";
    default:
      return "Upload failed. Try again?";
  }
}
