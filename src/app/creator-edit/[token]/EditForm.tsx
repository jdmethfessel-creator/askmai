"use client";

/**
 * Tokenized self-serve manage view for a creator's AskMai page.
 * Post-Mai: no voice_prompt / taste_profile textareas -- Mai has one
 * universal voice. What the creator can actually change here is the
 * SET of blog URLs Mai reads as grounding for travel / dining /
 * lifestyle answers.
 *
 * Save flow: PUT /api/creator-edit/[token] with { blog_urls: [] }.
 * The route wipes creator_content for this creator, re-fetches each
 * URL, chunks the text, and inserts fresh rows. Synchronous so the
 * creator sees the new chunk count back in the response.
 *
 * Catalog is read-only here. If a creator wants to add / remove
 * affiliate sources they'll need a follow-up feature (or a re-
 * onboard through /creator-signup for the same slug, which the
 * pipeline's upsert already supports).
 */

import { useCallback, useState } from "react";

type CatalogEntry = { source: string; count: number };

type Props = {
  token: string;
  slug: string;
  catalogSummary: CatalogEntry[];
  initialBlogUrls: string[];
  contentChunkCount: number;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | {
      kind: "saved";
      chunks: number;
      skipped: Array<{ url: string; reason: string }>;
    }
  | { kind: "error"; message: string };

export default function EditForm({
  token,
  slug,
  catalogSummary,
  initialBlogUrls,
  contentChunkCount,
}: Props) {
  const [blogUrls, setBlogUrls] = useState<string>(
    initialBlogUrls.join("\n")
  );
  const [state, setState] = useState<SaveState>({ kind: "idle" });

  const onSave = useCallback(async () => {
    setState({ kind: "saving" });
    const urls = blogUrls
      .split(/\s*[\n,]\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const r = await fetch(`/api/creator-edit/${token}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blog_urls: urls }),
      });
      const data = (await r.json().catch(() => null)) as {
        ok?: boolean;
        chunks?: number;
        skipped?: Array<{ url: string; reason: string }>;
        error?: string;
      } | null;
      if (!r.ok || !data?.ok) {
        setState({
          kind: "error",
          message:
            data?.error === "invalid_token"
              ? "This edit link isn't valid."
              : data?.error === "too_many_urls"
              ? "That's more URLs than we can process at once. Cap is 5."
              : `Save failed: ${data?.error ?? `http_${r.status}`}`,
        });
        return;
      }
      setState({
        kind: "saved",
        chunks: data.chunks ?? 0,
        skipped: data.skipped ?? [],
      });
    } catch (err) {
      setState({
        kind: "error",
        message: `Network error: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }, [token, blogUrls]);

  const totalCatalog = catalogSummary.reduce((acc, e) => acc + e.count, 0);

  return (
    <form
      className="edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <section className="edit-section">
        <label className="edit-label">Your affiliate catalog</label>
        <p className="edit-help">
          Read-only summary of what we&apos;ve imported. This is what
          the Shop tab shows your followers and what Mai recommends
          from when they ask about shopping.
        </p>
        {totalCatalog > 0 ? (
          <div className="edit-catalog-summary">
            <p className="edit-catalog-total">{totalCatalog} products total</p>
            <ul className="edit-catalog-list">
              {catalogSummary.map((entry) => (
                <li key={entry.source}>
                  <span className="edit-catalog-source">{entry.source}</span>
                  <span className="edit-catalog-count">{entry.count}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="edit-catalog-empty">
            No catalog rows yet. Re-onboard through /creator-signup with
            the same URL ({slug}) to import your affiliate links.
          </p>
        )}
      </section>

      <section className="edit-section">
        <label className="edit-label" htmlFor="blog_urls">
          Blog URLs Mai reads
        </label>
        <p className="edit-help">
          Travel, restaurants, hotels, guides — whatever you&apos;ve
          published. Mai pulls passages from these to answer non-
          fashion questions. One URL per line (or comma-separated). Up
          to 5 URLs per save.
        </p>
        <textarea
          id="blog_urls"
          className="edit-textarea edit-textarea-voice"
          value={blogUrls}
          onChange={(e) => {
            setBlogUrls(e.target.value);
            if (state.kind !== "idle") setState({ kind: "idle" });
          }}
          rows={8}
          placeholder="https://yourblog.com/tulum-guide&#10;https://yourblog.com/nyc-restaurants"
        />
        <p className="edit-meta">
          Currently: {contentChunkCount} passage
          {contentChunkCount === 1 ? "" : "s"} in Mai&apos;s content
          store
        </p>
      </section>

      <div className="edit-actions">
        <button
          type="submit"
          className="edit-btn edit-btn-primary"
          disabled={state.kind === "saving"}
        >
          {state.kind === "saving"
            ? "Fetching + chunking…"
            : "Save blog URLs"}
        </button>
        <a
          href={`/${slug}?mode=ask`}
          target="_blank"
          rel="noopener noreferrer"
          className="edit-btn edit-btn-secondary"
        >
          Open my page →
        </a>
      </div>

      {state.kind === "saved" ? (
        <div className="edit-toast edit-toast-ok">
          <p>
            Saved. Mai now has {state.chunks} passage
            {state.chunks === 1 ? "" : "s"} from your blog content.
          </p>
          {state.skipped.length > 0 ? (
            <>
              <p className="edit-meta">Skipped:</p>
              <ul className="edit-skipped-list">
                {state.skipped.map((s) => (
                  <li key={s.url}>
                    <code>{s.url}</code> — {s.reason}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
      {state.kind === "error" ? (
        <p className="edit-toast edit-toast-err">{state.message}</p>
      ) : null}
    </form>
  );
}
