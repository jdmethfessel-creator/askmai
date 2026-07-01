"use client";

/**
 * Self-serve creator onboarding form. Submits to
 * /api/creator-onboarding which runs the full pipeline (ingest +
 * voice gen + creator row + live page) synchronously and returns
 * the live URL + edit link in one response.
 *
 * UX shape:
 *   - Top: name / email / slug (auto-derived, editable)
 *   - Middle (PROMINENT): interview text + blog URL.
 *     These are the load-bearing inputs for voice quality. The form
 *     copy explains directly that without them the AI twin will
 *     sound generic. One of the two is effectively required (or at
 *     least: the submit button warns if both are empty).
 *   - Below: affiliate links (one field per source so the network
 *     detector has clean input)
 *   - Below: socials + short bio
 *
 *   On submit: a rotating progress message simulates pipeline
 *   stages (ingest → voice → live) so a 60-90s wait doesn't look
 *   stuck. Success state shows live URL + edit link + iframe
 *   preview of the live page.
 */

import { useEffect, useState } from "react";

type FormState =
  | { kind: "idle" }
  | { kind: "submitting"; startedAt: number }
  | {
      kind: "done";
      result: {
        slug: string;
        preview_url: string;
        edit_url: string | null;
        ingested: { total: number; by_network: Record<string, number> };
        content_chunks: number;
        skipped: Array<{ url: string; reason: string }>;
      };
    }
  | { kind: "error"; message: string };

const PROGRESS_MESSAGES = [
  "Pulling your affiliate catalogs…",
  "Counting your products…",
  "Reading your blog content…",
  "Chunking passages for Mai…",
  "Going live…",
];

export function SignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [slugHint, setSlugHint] = useState("");
  const [autoSlug, setAutoSlug] = useState(true);

  const [blogUrls, setBlogUrls] = useState("");

  const [shopmyUrl, setShopmyUrl] = useState("");
  const [shopbopUrl, setShopbopUrl] = useState("");
  const [revolveUrl, setRevolveUrl] = useState("");
  const [fwrdUrl, setFwrdUrl] = useState("");

  const [igHandle, setIgHandle] = useState("");
  const [tiktokHandle, setTiktokHandle] = useState("");

  const [state, setState] = useState<FormState>({ kind: "idle" });
  const [progressIdx, setProgressIdx] = useState(0);

  // Keep slug auto-derived from name until the user explicitly
  // edits the slug input.
  useEffect(() => {
    if (autoSlug) setSlugHint(slugify(name));
  }, [name, autoSlug]);

  // Rotate the progress message so the spinner doesn't read as
  // stuck during the 60-90s pipeline wait.
  useEffect(() => {
    if (state.kind !== "submitting") return;
    const id = setInterval(() => {
      setProgressIdx((i) => (i + 1) % PROGRESS_MESSAGES.length);
    }, 7_000);
    return () => clearInterval(id);
  }, [state.kind]);

  const affiliateUrls = [
    shopmyUrl,
    shopbopUrl,
    revolveUrl,
    fwrdUrl,
  ]
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
  const blogUrlList = blogUrls
    .split(/\s*[\n,]\s*/)
    .map((u) => u.trim())
    .filter(Boolean);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const canSubmit =
    name.trim().length > 0 &&
    emailValid &&
    affiliateUrls.length > 0 &&
    state.kind !== "submitting" &&
    state.kind !== "done";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setState({ kind: "submitting", startedAt: Date.now() });
    setProgressIdx(0);
    try {
      const r = await fetch("/api/creator-onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          slug_hint: slugHint.trim() || undefined,
          ig_handle: igHandle.trim() || undefined,
          tiktok_handle: tiktokHandle.trim() || undefined,
          affiliate_urls: affiliateUrls,
          blog_urls: blogUrlList,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => null);
        if (data?.error === "slug_taken" && data?.suggested) {
          setState({
            kind: "error",
            message: `That URL is taken (askmai.co/${data.slug}). Try ${data.suggested}.`,
          });
          setSlugHint(data.suggested);
          setAutoSlug(false);
          return;
        }
        setState({
          kind: "error",
          message: messageFor(data?.error ?? `http_${r.status}`),
        });
        return;
      }
      const result = (await r.json()) as Extract<FormState, { kind: "done" }>["result"];
      setState({ kind: "done", result });
    } catch (err) {
      setState({
        kind: "error",
        message:
          err instanceof Error
            ? `Network error: ${err.message}`
            : "Network error. Try again?",
      });
    }
  }

  if (state.kind === "done") {
    return <SuccessCard result={state.result} />;
  }

  return (
    <form onSubmit={onSubmit} className="signup-form" noValidate>
      <section className="signup-section">
        <h2 className="signup-h2">Who you are</h2>
        <div className="signup-grid">
          <Field
            id="name"
            label="Your name"
            value={name}
            onChange={setName}
            autoComplete="name"
            required
            maxLength={120}
          />
          <Field
            id="email"
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            required
            maxLength={200}
          />
          <Field
            id="slug"
            label="Your URL"
            value={slugHint}
            onChange={(v) => {
              setSlugHint(v);
              setAutoSlug(false);
            }}
            placeholder="auto-fills from your name"
            prefix="askmai.co/"
            maxLength={48}
          />
        </div>
      </section>

      <section className="signup-section signup-section-highlight">
        <h2 className="signup-h2">
          Drop your affiliate links{" "}
          <span className="signup-required">*</span>
        </h2>
        <p className="signup-section-sub">
          Your fashion &amp; beauty shopping recs. Mai recommends
          from these and followers try them on. LTK isn&apos;t
          supported yet — anything we can&apos;t read gets skipped
          and reported back.
        </p>
        <div className="signup-grid">
          <Field
            id="shopmy"
            label="ShopMy"
            placeholder="shopmy.us/shop/yourhandle"
            value={shopmyUrl}
            onChange={setShopmyUrl}
            maxLength={400}
          />
          <Field
            id="shopbop"
            label="Shopbop hearts"
            placeholder="shopbop.com/hearts/yourhandle/..."
            value={shopbopUrl}
            onChange={setShopbopUrl}
            maxLength={400}
          />
          <Field
            id="revolve"
            label="Revolve favorites"
            placeholder="revolve.com/content/favorites/..."
            value={revolveUrl}
            onChange={setRevolveUrl}
            maxLength={400}
          />
          <Field
            id="fwrd"
            label="FWRD wishlist"
            placeholder="fwrd.com/fw/PublicWishListView..."
            value={fwrdUrl}
            onChange={setFwrdUrl}
            maxLength={400}
          />
        </div>
      </section>

      <section className="signup-section signup-section-highlight">
        <h2 className="signup-h2">Drop your blog links</h2>
        <p className="signup-section-sub">
          Travel, restaurants &amp; more. Mai reads these so she can
          answer non-fashion questions from your actual guides — the
          hotel from that Tulum trip, the pasta place you keep
          re-linking. Comma- or newline-separated.
        </p>
        <Field
          id="blog_urls"
          label="Blog / Substack / travel guide URLs"
          value={blogUrls}
          onChange={setBlogUrls}
          placeholder="https://yourblog.com/tulum-guide, https://yourblog.com/nyc-favorites"
          maxLength={2000}
        />
      </section>

      <section className="signup-section">
        <h2 className="signup-h2">Optional context</h2>
        <div className="signup-grid">
          <Field
            id="ig"
            label="Instagram handle"
            placeholder="@yourhandle"
            value={igHandle}
            onChange={setIgHandle}
            maxLength={120}
          />
          <Field
            id="tiktok"
            label="TikTok handle"
            placeholder="@yourhandle"
            value={tiktokHandle}
            onChange={setTiktokHandle}
            maxLength={120}
          />
        </div>
      </section>

      <button
        type="submit"
        className="lp-btn lp-btn-primary lp-btn-large signup-submit"
        disabled={!canSubmit}
      >
        {state.kind === "submitting" ? "Building…" : "Launch my page"}
      </button>

      {state.kind === "submitting" ? (
        <ProgressPanel
          message={PROGRESS_MESSAGES[progressIdx]}
          startedAt={state.startedAt}
        />
      ) : null}
      {state.kind === "error" ? (
        <p className="signup-error">{state.message}</p>
      ) : null}
    </form>
  );
}

function ProgressPanel({
  message,
  startedAt,
}: {
  message: string;
  startedAt: number;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <div className="signup-progress">
      <p className="signup-progress-msg">{message}</p>
      <p className="signup-progress-sub">
        {elapsed}s — this typically takes 30-90 seconds. Don&apos;t
        close the tab.
      </p>
    </div>
  );
}

function SuccessCard({
  result,
}: {
  result: Extract<FormState, { kind: "done" }>["result"];
}) {
  const byNetwork = Object.entries(result.ingested.by_network)
    .map(([net, n]) => `${net}: ${n}`)
    .join(", ");
  return (
    <div className="signup-success">
      <h2 className="signup-success-h2">
        Your AskMai page is{" "}
        <span className="lp-accent-ink">live.</span>
      </h2>
      <p className="signup-success-sub">
        Open it in a new tab to share. Use the manage link to add or
        edit your blog and affiliate sources any time.
      </p>

      <div className="signup-success-actions">
        <a
          href={result.preview_url}
          target="_blank"
          rel="noopener noreferrer"
          className="lp-btn lp-btn-primary lp-btn-large"
        >
          Open my page →
        </a>
        {result.edit_url ? (
          <a
            href={result.edit_url}
            target="_blank"
            rel="noopener noreferrer"
            className="lp-btn lp-btn-secondary lp-btn-large"
          >
            Manage my page
          </a>
        ) : null}
      </div>

      <div className="signup-success-preview-wrap">
        <p className="signup-success-preview-label">Live preview</p>
        <div className="signup-success-preview">
          <iframe
            src={result.preview_url}
            title="Your AskMai page preview"
            loading="lazy"
            className="signup-success-iframe"
          />
        </div>
      </div>

      <dl className="signup-success-meta">
        <div className="signup-meta-row">
          <dt>URL</dt>
          <dd>askmai.co/{result.slug}</dd>
        </div>
        <div className="signup-meta-row">
          <dt>Catalog ingested</dt>
          <dd>
            {result.ingested.total} items
            {byNetwork ? ` (${byNetwork})` : null}
          </dd>
        </div>
        <div className="signup-meta-row">
          <dt>Content for Mai</dt>
          <dd>
            {result.content_chunks > 0
              ? `${result.content_chunks} passages from your blog content, ready for travel/dining questions.`
              : "No blog content added. Mai will answer fashion questions only until you add blog URLs from the manage link."}
          </dd>
        </div>
        {result.skipped.length > 0 ? (
          <div className="signup-meta-row">
            <dt>Skipped sources</dt>
            <dd>
              <ul className="signup-skipped-list">
                {result.skipped.map((s) => (
                  <li key={s.url}>
                    <code>{s.url}</code> — {s.reason}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ) : null}
      </dl>

      <p className="signup-success-email">
        We also emailed both links so you can come back later.
      </p>
    </div>
  );
}

// ----- Field primitives -----

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
  prefix,
  help,
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
  prefix?: string;
  help?: string;
}) {
  return (
    <label className="signup-field" htmlFor={id}>
      <span className="signup-field-label">
        {label}
        {required && <span className="signup-field-required"> *</span>}
      </span>
      <div className={`signup-input-wrap${prefix ? " has-prefix" : ""}`}>
        {prefix ? <span className="signup-input-prefix">{prefix}</span> : null}
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
      </div>
      {help ? <span className="signup-field-help">{help}</span> : null}
    </label>
  );
}

function FieldTextarea({
  id,
  label,
  value,
  onChange,
  rows = 4,
  maxLength,
  placeholder,
  help,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  help?: string;
}) {
  return (
    <label className="signup-field" htmlFor={id}>
      <span className="signup-field-label">{label}</span>
      {help ? <span className="signup-field-help">{help}</span> : null}
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        className="signup-textarea"
      />
    </label>
  );
}

// Local slug helper -- mirrors src/lib/onboarding/slug.ts so the
// form can preview the auto-derived URL without an extra round
// trip. Keep in sync with the server's slugify() (lowercase,
// hyphenate non-alphanumeric runs, strip combining marks).
function slugify(input: string): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function messageFor(code: string): string {
  switch (code) {
    case "missing_name":
      return "Please add your name.";
    case "invalid_email":
      return "That email doesn't look right.";
    case "missing_affiliate_urls":
      return "Add at least one affiliate URL (ShopMy, Shopbop, Revolve, or FWRD).";
    case "slug_underivable":
      return "We couldn't make a URL from your name. Try filling in the URL field manually.";
    case "application_store_failed":
      return "Something went wrong saving your application. Try again, or email hi@askmai.co.";
    case "creator_create_failed":
      return "Something went wrong creating your page. Try again, or email hi@askmai.co.";
    default:
      return `Something went wrong (${code}). Try again, or email hi@askmai.co.`;
  }
}
