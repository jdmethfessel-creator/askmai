/**
 * Best-effort blog/interview text fetcher for the onboarding voice
 * generator. The LLM needs prose in the creator's actual voice to
 * write a passable voice_prompt; the creator's typed interview is
 * the primary input, blog URLs are secondary.
 *
 * Concretely: GET each URL with a 5-second timeout, strip the HTML
 * down to visible body text, cap at MAX_CHARS so a long Substack
 * post doesn't blow the LLM context. Failures (timeout, 404, parse
 * fail) are silently ignored — the pipeline continues with whatever
 * text we got.
 *
 * Intentional non-goals: JS-rendered content (no headless browser),
 * paywalled content (Substack premium etc.), private feeds, image
 * OCR. The contract is "if the creator hands us a publicly-readable
 * blog URL, we read the text." Anything more is out of scope for v1.
 */

const FETCH_TIMEOUT_MS = 5_000;
const MAX_CHARS_PER_URL = 20_000;
const UA =
  "Mozilla/5.0 (compatible; AskMaiVoiceFetcher/1.0; +https://askmai.co)";

export type BlogFetchResult = {
  url: string;
  text: string;
  error?: string;
};

export async function fetchBlogText(url: string): Promise<BlogFetchResult> {
  try {
    new URL(url); // throws if not a URL
  } catch {
    return { url, text: "", error: "invalid_url" };
  }
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html, */*" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) {
      return { url, text: "", error: `http_${res.status}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      return { url, text: "", error: `unsupported_ct_${ct.split(";")[0]}` };
    }
    const raw = await res.text();
    const text = stripHtml(raw).slice(0, MAX_CHARS_PER_URL);
    return { url, text };
  } catch (err) {
    return {
      url,
      text: "",
      error: err instanceof Error ? err.name : "fetch_failed",
    };
  }
}

/**
 * Fire all URLs in parallel and return the results. Bounded by
 * FETCH_TIMEOUT_MS per URL so the total wait is also ~5 seconds.
 * Each result carries its own error string when failed; callers
 * filter to text.length > 0.
 */
export async function fetchManyBlogTexts(
  urls: string[]
): Promise<BlogFetchResult[]> {
  const cleaned = urls.map((u) => u?.trim()).filter((u): u is string => !!u);
  if (cleaned.length === 0) return [];
  return Promise.all(cleaned.map(fetchBlogText));
}

/**
 * HTML -> rough plain text. Drops script/style/noscript blocks
 * outright, then strips remaining tags. Collapses whitespace runs
 * so a 50-line nav menu becomes a couple of words and the LLM's
 * token budget goes to actual content. NOT a precision parser --
 * if a site embeds primary content inside <script> (modern SPA
 * shells), we get nothing. That's the documented trade-off.
 */
function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
