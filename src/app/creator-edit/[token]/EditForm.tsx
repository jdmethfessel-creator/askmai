"use client";

/**
 * Tokenized self-serve voice + taste editor for a single creator.
 * Two textareas (one for the prose voice_prompt, one for the JSON
 * taste_profile) backed by PUT /api/creator-edit/[token].
 *
 * Validation mirrors the API route's: voice_prompt non-empty,
 * taste_profile is a JSON object with identity.name. The UI
 * pre-validates the JSON before sending so the operator gets the
 * line-number error immediately rather than a generic 400.
 *
 * "Preview" button opens the live page in a new tab so the user
 * can read their AI's responses with the edits applied. There's
 * no live render preview here -- the chat needs the user to
 * actually ask a question, and the response stream + product
 * cards are heavy enough that an inline iframe wouldn't add much
 * over the new-tab open.
 */

import { useCallback, useState } from "react";

type Props = {
  token: string;
  initialVoicePrompt: string;
  initialTasteProfile: unknown;
  slug: string;
};

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export default function EditForm({
  token,
  initialVoicePrompt,
  initialTasteProfile,
  slug,
}: Props) {
  const [voicePrompt, setVoicePrompt] = useState(initialVoicePrompt);
  const [tasteJson, setTasteJson] = useState(() =>
    JSON.stringify(initialTasteProfile, null, 2)
  );
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const onSave = useCallback(async () => {
    setSave({ kind: "saving" });
    // Pre-parse JSON locally so the operator gets a line-number
    // error before the network round trip.
    let parsed: unknown;
    try {
      parsed = JSON.parse(tasteJson);
    } catch (e) {
      setSave({
        kind: "error",
        message: `Taste profile is not valid JSON: ${e instanceof Error ? e.message : "parse failed"}`,
      });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setSave({
        kind: "error",
        message: "Taste profile must be a JSON object.",
      });
      return;
    }
    const taste = parsed as Record<string, unknown>;
    if (
      !taste.identity ||
      typeof taste.identity !== "object" ||
      typeof (taste.identity as Record<string, unknown>).name !== "string"
    ) {
      setSave({
        kind: "error",
        message:
          'Taste profile must include identity.name (the creator\'s display name).',
      });
      return;
    }
    if (voicePrompt.trim().length < 50) {
      setSave({
        kind: "error",
        message:
          "Voice prompt is too short — at least a few sentences are required.",
      });
      return;
    }
    try {
      const r = await fetch(`/api/creator-edit/${token}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          voice_prompt: voicePrompt,
          taste_profile: parsed,
        }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => null);
        setSave({
          kind: "error",
          message: `Save failed: ${data?.error ?? `http_${r.status}`}`,
        });
        return;
      }
      setSave({ kind: "saved" });
    } catch (err) {
      setSave({
        kind: "error",
        message: `Network error: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }, [token, voicePrompt, tasteJson]);

  return (
    <form
      className="edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <section className="edit-section">
        <label className="edit-label" htmlFor="voice_prompt">
          Voice prompt
        </label>
        <p className="edit-help">
          The style guide your AI twin uses when answering. Be
          specific about phrasing tics, banned filler words, opinions
          you actually hold. Multi-paragraph is good. Sections like
          HOW SHE TALKS / THINGS THAT KILL THE VIBE / ANSWER SHAPE
          render well.
        </p>
        <textarea
          id="voice_prompt"
          className="edit-textarea edit-textarea-voice"
          value={voicePrompt}
          onChange={(e) => {
            setVoicePrompt(e.target.value);
            if (save.kind !== "idle") setSave({ kind: "idle" });
          }}
          rows={18}
        />
        <p className="edit-meta">{voicePrompt.length} characters</p>
      </section>

      <section className="edit-section">
        <label className="edit-label" htmlFor="taste_profile">
          Taste profile (JSON)
        </label>
        <p className="edit-help">
          Structured data your AI pulls from for recommendations. Must
          stay valid JSON with at least an identity.name field. Add
          / remove sections to taste; the chat reads identity,
          fashion, beauty, dining, lifestyle, travel.
        </p>
        <textarea
          id="taste_profile"
          className="edit-textarea edit-textarea-json"
          value={tasteJson}
          spellCheck={false}
          onChange={(e) => {
            setTasteJson(e.target.value);
            if (save.kind !== "idle") setSave({ kind: "idle" });
          }}
          rows={26}
        />
      </section>

      <div className="edit-actions">
        <button
          type="submit"
          className="edit-btn edit-btn-primary"
          disabled={save.kind === "saving"}
        >
          {save.kind === "saving" ? "Saving…" : "Save changes"}
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
      {save.kind === "saved" ? (
        <p className="edit-toast edit-toast-ok">
          Saved. Refresh your page to see the new voice.
        </p>
      ) : null}
      {save.kind === "error" ? (
        <p className="edit-toast edit-toast-err">{save.message}</p>
      ) : null}
    </form>
  );
}
