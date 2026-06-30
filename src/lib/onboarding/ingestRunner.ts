/**
 * In-process wrapper around the existing scripts/ingest-creator-
 * products parsers so the onboarding API route can ingest a
 * creator's affiliate URLs without shelling out to the CLI.
 *
 * The parsers themselves live in scripts/ as ESM JS (network
 * detection, HTML scraping, ShopMy API client, byte-for-byte
 * affiliate URL preservation). Dynamic-importing them keeps a
 * single source of truth -- the CLI and the API route ingest
 * with identical logic.
 *
 * Safeguard (a) from the onboarding spec: every URL is wrapped in
 * try/catch. A failed fetch / parse / zero-row result returns a
 * `{ url, products: [], error }` row instead of throwing, so the
 * pipeline continues with whichever URLs did parse. The route
 * collects the skipped list and surfaces it to the creator.
 *
 * LTK is not yet supported by detectNetwork (only shopbop /
 * revolve / fwrd / shopmy). LTK URLs come back with
 * error="ltk_not_supported_yet" so the creator sees a clear
 * note rather than a silent drop.
 */

// Dynamic import so Next.js bundles the .mjs only when this lib
// is referenced. The parsers run on Node runtime (they use fetch
// against retailer pages); the onboarding route declares Node
// runtime explicitly.
type Parsers = typeof import("../../../scripts/ingest-creator-products/parsers.mjs");
let parsersPromise: Promise<Parsers> | null = null;
async function loadParsers(): Promise<Parsers> {
  if (!parsersPromise) {
    parsersPromise = import(
      "../../../scripts/ingest-creator-products/parsers.mjs"
    ) as Promise<Parsers>;
  }
  return parsersPromise;
}

/**
 * Row shape returned by every parser. Mirrors the
 * creator_products schema fields the parsers fill (creator_id
 * comes from the route since the parsers don't know about it).
 */
export type IngestRow = {
  source_network: string;
  source_external_id: string | null;
  product_title: string;
  brand: string | null;
  price: number | null;
  price_display: string | null;
  image_url: string;
  affiliate_url: string;
  product_category: string | null;
  product_subcategory: string | null;
  raw?: unknown;
  ingested_from?: string;
};

export type IngestResult = {
  /** The original URL the creator submitted. */
  url: string;
  /** Detected network (shopbop / revolve / fwrd / shopmy) or null
   *  if the host wasn't recognized. */
  network: string | null;
  /** Parsed rows. Empty when error is set. */
  products: IngestRow[];
  /** Set when this URL was skipped. Pipeline keeps going. */
  error?: string;
};

/**
 * Detect-and-parse a single source URL. Never throws -- a failure
 * lands in the returned error field so the caller can keep
 * processing the other URLs.
 */
export async function ingestOneSource(url: string): Promise<IngestResult> {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return { url: trimmed, network: null, products: [], error: "empty_url" };
  let parsers: Parsers;
  try {
    parsers = await loadParsers();
  } catch (err) {
    return {
      url: trimmed,
      network: null,
      products: [],
      error: `parsers_load_failed:${err instanceof Error ? err.message : "?"}`,
    };
  }
  let network: string | null = null;
  try {
    network = parsers.detectNetwork(trimmed);
  } catch {
    network = null;
  }
  if (!network) {
    // Common-case heuristics for the not-yet-supported networks so
    // the creator sees an actionable error rather than a generic
    // "unknown network" dump. LTK (shopltk.com / liketk.it /
    // rstyle.me) is the big one.
    const host = (() => {
      try {
        return new URL(trimmed).hostname.toLowerCase();
      } catch {
        return "";
      }
    })();
    if (
      host.includes("shopltk") ||
      host.includes("liketk") ||
      host.includes("rstyle")
    ) {
      return {
        url: trimmed,
        network: null,
        products: [],
        error: "ltk_not_supported_yet",
      };
    }
    return {
      url: trimmed,
      network: null,
      products: [],
      error: "unknown_network",
    };
  }
  try {
    // ShopMy URLs route through the whole-shop client when the URL
    // matches /shop/<username>. ingestUrl handles the
    // shopbop/revolve/fwrd path; anything else routes through the
    // ShopMy whole-shop fetcher when the host is shopmy.us.
    if (network === "shopmy") {
      const username = extractShopMyUsername(trimmed);
      if (!username) {
        return {
          url: trimmed,
          network,
          products: [],
          error: "shopmy_username_not_in_url",
        };
      }
      // creatorSlug is only used inside parsers for affiliate-URL
      // tagging context; the onboarding route doesn't yet know the
      // final slug at parse time (slug-collision check runs after
      // ingest in the route). Pass an empty placeholder; the ShopMy
      // parser writes the user's slug into u1 internally when set
      // and otherwise omits the tag.
      const rows = await parsers.fetchShopMyShop({
        username,
        creatorSlug: "",
      });
      return {
        url: trimmed,
        network,
        products: (rows as IngestRow[]) ?? [],
        error: rows.length === 0 ? "zero_products" : undefined,
      };
    }
    const rows = await parsers.ingestUrl(trimmed);
    return {
      url: trimmed,
      network,
      products: (rows as IngestRow[]) ?? [],
      error: rows.length === 0 ? "zero_products" : undefined,
    };
  } catch (err) {
    return {
      url: trimmed,
      network,
      products: [],
      error: `parse_failed:${err instanceof Error ? err.message : "?"}`,
    };
  }
}

/**
 * Fire every source in parallel. Each result carries its own
 * pass/fail status so the caller never has to short-circuit on a
 * single bad URL.
 */
export async function ingestManySources(urls: string[]): Promise<IngestResult[]> {
  return Promise.all(urls.map(ingestOneSource));
}

function extractShopMyUsername(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith("shopmy.us")) return null;
    // Expected: /shop/<username> or /shop/<username>/something
    const m = u.pathname.match(/^\/shop\/([a-zA-Z0-9._-]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
