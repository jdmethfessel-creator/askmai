"use client";

import { useState } from "react";

type FormState = "idle" | "sending" | "done" | "error";

export const FOLLOWER_RANGES = [
  "Under 10K",
  "10K – 50K",
  "50K – 250K",
  "250K – 1M",
  "1M+",
] as const;
type FollowerRange = (typeof FOLLOWER_RANGES)[number];

export function SignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [shopmyUrl, setShopmyUrl] = useState("");
  const [ltkUrl, setLtkUrl] = useState("");
  const [igHandle, setIgHandle] = useState("");
  const [tiktokHandle, setTiktokHandle] = useState("");
  // Newer fields per the onboarding-form spec — captured for the
  // founder email; not stored in creator_applications (no schema
  // column for them, and they're decision-time signal, not record-
  // of-truth data).
  const [followerRange, setFollowerRange] = useState<FollowerRange | "">("");
  const [affiliateNetworks, setAffiliateNetworks] = useState("");
  const [note, setNote] = useState("");
  const [state, setState] = useState<FormState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const profileSignals =
    shopmyUrl.trim() ||
    ltkUrl.trim() ||
    igHandle.trim() ||
    tiktokHandle.trim();
  const canSubmit =
    name.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) &&
    Boolean(profileSignals) &&
    state !== "sending" &&
    state !== "done";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setState("sending");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/creator-applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          shopmy_url: shopmyUrl.trim() || null,
          ltk_url: ltkUrl.trim() || null,
          ig_handle: igHandle.trim() || null,
          tiktok_handle: tiktokHandle.trim() || null,
          follower_range: followerRange || null,
          affiliate_networks: affiliateNetworks.trim() || null,
          note: note.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const err = data?.error ?? `status_${res.status}`;
        setState("error");
        setErrorMessage(messageFor(err));
        return;
      }
      setState("done");
    } catch {
      setState("error");
      setErrorMessage("Network blip. Try again?");
    }
  }

  if (state === "done") {
    return (
      <div className="signup-success">
        <h2 className="signup-success-h2">
          Thanks — we&apos;ll be in touch{" "}
          <span className="lp-accent-ink">to set up your twin.</span>
        </h2>
        <p className="signup-success-sub">
          Your application is in. We review by hand and reach out
          personally once we&apos;ve had a look at your feed. You
          should hear from us within a few days.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="signup-form" noValidate>
      <div className="signup-grid">
        <Field
          id="name"
          label="Your name"
          value={name}
          onChange={setName}
          autoComplete="name"
          maxLength={120}
          required
        />
        <Field
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          maxLength={200}
          required
        />
        <Field
          id="shopmy"
          label="ShopMy profile or URL"
          placeholder="e.g. shopmy.us/shop/yourhandle"
          value={shopmyUrl}
          onChange={setShopmyUrl}
          maxLength={400}
        />
        <Field
          id="ltk"
          label="LTK profile or URL"
          placeholder="e.g. shopltk.com/profile/yourhandle"
          value={ltkUrl}
          onChange={setLtkUrl}
          maxLength={400}
        />
        <Field
          id="ig"
          label="Instagram"
          placeholder="@yourhandle"
          value={igHandle}
          onChange={setIgHandle}
          maxLength={120}
        />
        <Field
          id="tiktok"
          label="TikTok"
          placeholder="@yourhandle"
          value={tiktokHandle}
          onChange={setTiktokHandle}
          maxLength={120}
        />
      </div>

      <div className="signup-grid">
        <FieldSelect
          id="follower_range"
          label="Follower range"
          value={followerRange}
          onChange={(v) => setFollowerRange(v as FollowerRange | "")}
          options={[
            { value: "", label: "Select…" },
            ...FOLLOWER_RANGES.map((r) => ({ value: r, label: r })),
          ]}
        />
        <Field
          id="affiliate_networks"
          label="Affiliate networks you use"
          placeholder="e.g. ShopMy, LTK, RewardStyle, Skimlinks…"
          value={affiliateNetworks}
          onChange={setAffiliateNetworks}
          maxLength={300}
        />
      </div>

      <FieldTextarea
        id="note"
        label="Anything else worth knowing? (optional)"
        value={note}
        onChange={setNote}
        maxLength={1200}
      />

      <p className="signup-helper">
        Add at least one of ShopMy, LTK, Instagram, or TikTok so we have
        somewhere to find you.
      </p>

      <button
        type="submit"
        className="lp-btn lp-btn-primary lp-btn-large signup-submit"
        disabled={!canSubmit}
      >
        {state === "sending" ? "Sending…" : "Apply"}
      </button>

      {state === "error" && (
        <p className="signup-error">{errorMessage}</p>
      )}
    </form>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoComplete,
  maxLength,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
  required?: boolean;
}) {
  return (
    <label className="signup-field" htmlFor={id}>
      <span className="signup-field-label">
        {label}
        {required && <span className="signup-field-required"> *</span>}
      </span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        required={required}
        className="signup-input"
      />
    </label>
  );
}

function FieldSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="signup-field" htmlFor={id}>
      <span className="signup-field-label">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="signup-input"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FieldTextarea({
  id,
  label,
  value,
  onChange,
  maxLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  maxLength?: number;
}) {
  return (
    <label className="signup-field" htmlFor={id}>
      <span className="signup-field-label">{label}</span>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        rows={4}
        className="signup-textarea"
      />
    </label>
  );
}

function messageFor(code: string): string {
  switch (code) {
    case "missing_name":
      return "Please add your name.";
    case "invalid_email":
      return "That email doesn't look right.";
    case "missing_profile_signal":
      return "Add at least one of ShopMy, LTK, Instagram, or TikTok.";
    case "store_failed":
      return "We couldn't save it. Try again, or email hi@askmai.co.";
    default:
      return "Something went wrong. Try again, or email hi@askmai.co.";
  }
}
