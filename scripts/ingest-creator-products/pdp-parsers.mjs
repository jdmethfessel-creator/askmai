// PDP fit-data parsers. Consumes a fetched product detail page's HTML
// for one of the four networks we ingest today and returns a
// normalized fit-data payload that maps 1:1 onto migration 015's
// product_fit table.
//
// Every field is best-effort. NULL is the safe default. The engine
// (P1c) degrades honestly from "full rec" down to "nothing" based on
// which of these fields the parser actually produced, so a partial
// extraction never turns into an invented rec.
//
// Grounding: see the P0 diagnosis. Revolve + FWRD share infrastructure
// and expose model reference + size chart + review consensus in
// structured slots. Shopbop puts model reference into free prose in
// the description; parse via regex. ShopMy is a redirect layer -- we
// only handle its destinations that resolve to one of the three
// direct networks and skip everything else.

const FT_IN_TO_CM = 2.54;

// "5'9\"" -> 175. "5' 9" -> 175. "5'9" -> 175. "175 cm" -> 175.
// Returns null on no match.
export function heightToCm(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s+/g, "");
  const imp = s.match(/(\d)'(\d{1,2})/);
  if (imp) {
    const ft = Number(imp[1]);
    const inches = Number(imp[2]);
    return Math.round((ft * 12 + inches) * FT_IN_TO_CM);
  }
  const cm = s.match(/(\d{2,3})cm/i);
  if (cm) return Number(cm[1]);
  return null;
}

// Loose keyword-based classification from a prose fit note. We treat
// this as a fallback when the retailer doesn't ship an aggregated
// consensus. Returns 'small' | 'true' | 'large' | null.
export function classifyFitNote(note) {
  if (!note) return null;
  const s = String(note).toLowerCase();
  if (/(runs?\s+small|size\s+up|order\s+up|consider\s+sizing\s+up)/.test(s)) {
    return "small";
  }
  if (/(runs?\s+large|size\s+down|order\s+down|consider\s+sizing\s+down)/.test(s)) {
    return "large";
  }
  if (/(true\s+to\s+size|fits\s+true|tts\b)/.test(s)) return "true";
  return null;
}

// Merge classifier fallback with consensus percentages. If the review
// pool is large (count >= 20) and one bucket clears 55%, trust it;
// otherwise fall back to the prose classification.
export function resolveFitRun({ note, consensus }) {
  const fromNote = classifyFitNote(note);
  if (consensus && typeof consensus === "object") {
    const count = Number(consensus.count ?? 0);
    if (count >= 20) {
      const buckets = { small: 0, true: 0, large: 0 };
      for (const k of Object.keys(buckets)) {
        const v = Number(consensus[k] ?? 0);
        if (Number.isFinite(v)) buckets[k] = v;
      }
      let winner = null;
      let peak = 0;
      for (const [k, v] of Object.entries(buckets)) {
        if (v > peak) {
          peak = v;
          winner = k;
        }
      }
      if (winner && peak >= 55) return winner;
    }
  }
  return fromNote;
}

// ---------- Revolve / FWRD (shared template) ------------------------

// Both retailers render server-side. Model reference lives in a
// dt/dd list under "Model Height / Wearing Size". Size chart is
// exposed via a per-brand JSON blob referenced from a "Size Chart"
// modal link. Review consensus lands under a "fit_rating" JSON
// stanza in the reviews block.
function parseRevolveShared({ html, network }) {
  // Model reference block. On Revolve/FWRD it renders as literal:
  //   Model Height: 5'9"
  //   Model Wearing Size: XS
  // (line breaks between labels vary; parse with a permissive regex
  //  and strip inline HTML.)
  const clean = html.replace(/<[^>]+>/g, " ");
  const heightMatch = clean.match(
    /Model\s*Height[:\s]+(\d)['’](\d{1,2})/i
  );
  const sizeMatch = clean.match(
    /Model\s*(?:is\s+wearing|Wearing)\s*Size[:\s]+([A-Za-z0-9]+)/i
  );
  const model_height_cm = heightMatch
    ? heightToCm(`${heightMatch[1]}'${heightMatch[2]}`)
    : null;
  const model_size = sizeMatch ? sizeMatch[1].trim().toUpperCase() : null;
  const model_size_scale = model_size
    ? /^[SMLX]+$/.test(model_size)
      ? "letter"
      : "us"
    : null;

  // Fit prose. Revolve wraps it in <p class="fit-notes"> or similar;
  // fall back to keyword-anchored extraction from the raw text.
  let fit_note = null;
  const fitProse = clean.match(
    /(?:About\s+this\s+Fit|Fit\s*Notes?)[:\s]+([^.]{20,300}\.)/i
  );
  if (fitProse) fit_note = fitProse[1].trim();

  // Aggregated fit consensus. Revolve exposes it in a script tag as
  // JSON: "fit_rating":{"true":78,"small":15,"large":7,"count":132}
  // Look for the JSON stanza directly.
  let fit_consensus = null;
  const consensusMatch = html.match(
    /"fit_rating"\s*:\s*(\{[^}]{4,120}\})/
  );
  if (consensusMatch) {
    try {
      fit_consensus = JSON.parse(consensusMatch[1]);
    } catch {
      /* leave null on parse failure */
    }
  }

  // Size chart. Both retailers link a per-brand size chart from a
  // "Size Chart" modal. The rendered HTML typically embeds the chart
  // as a table with data-scale="us" or an inline JSON blob. We look
  // for the JSON blob first (fast + robust); table scraping is a
  // follow-up if we ever hit a page that only ships the table.
  let size_chart = null;
  const chartMatch = html.match(/"size_chart"\s*:\s*(\{[\s\S]{10,4000}?\})/);
  if (chartMatch) {
    try {
      size_chart = JSON.parse(chartMatch[1]);
    } catch {
      /* leave null; chart parsing continues to be best-effort */
    }
  }

  const fit_run = resolveFitRun({ note: fit_note, consensus: fit_consensus });

  return {
    source_network: network,
    model_height_cm,
    model_size,
    model_size_scale,
    fit_note,
    fit_run,
    fit_consensus,
    size_chart,
  };
}

export function parseRevolvePdp({ html }) {
  return parseRevolveShared({ html, network: "revolve" });
}

export function parseFwrdPdp({ html }) {
  return parseRevolveShared({ html, network: "fwrd" });
}

// ---------- Shopbop -----------------------------------------------

// Shopbop puts model reference into free prose in the product
// description. The description ships in the hydration JSON blob
// under productDetails.description; when the JSON is present we
// parse from that string; otherwise fall back to a regex over the
// rendered HTML.
export function parseShopbopPdp({ html }) {
  const clean = html.replace(/<[^>]+>/g, " ");

  const heightMatch = clean.match(
    /Model\s+is\s+(\d)['’]\s*(\d{1,2})/i
  );
  const sizeMatch = clean.match(
    /(?:wearing|in)\s+(?:US\s+)?size\s+([A-Za-z0-9]+)/i
  );
  const model_height_cm = heightMatch
    ? heightToCm(`${heightMatch[1]}'${heightMatch[2]}`)
    : null;
  const model_size = sizeMatch ? sizeMatch[1].trim().toUpperCase() : null;
  const model_size_scale = model_size
    ? /^[SMLX]+$/.test(model_size)
      ? "letter"
      : "us"
    : null;

  // Fit prose is often in the description; anchor to the sentence
  // that carries a fit-run keyword so we capture just that sentence.
  let fit_note = null;
  const noteMatch = clean.match(
    /([^.]*?\b(?:runs?\s+small|runs?\s+large|true\s+to\s+size|size\s+up|size\s+down)[^.]*\.)/i
  );
  if (noteMatch) fit_note = noteMatch[1].trim();

  // No aggregated consensus on Shopbop today. Individual review data
  // could be aggregated client-side but we intentionally skip: the
  // engine correctly treats a NULL consensus as "no signal" and
  // won't invent one.
  const fit_consensus = null;
  const size_chart = null; // future work: fetch the per-brand chart modal

  const fit_run = resolveFitRun({ note: fit_note, consensus: fit_consensus });

  return {
    source_network: "shopbop",
    model_height_cm,
    model_size,
    model_size_scale,
    fit_note,
    fit_run,
    fit_consensus,
    size_chart,
  };
}

// ---------- Dispatch -----------------------------------------------

export function detectNetworkFromPdpUrl(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("shopbop.com")) return "shopbop";
  if (u.includes("revolve.com")) return "revolve";
  if (u.includes("fwrd.com")) return "fwrd";
  return null;
}

export function parsePdp({ html, url }) {
  const network = detectNetworkFromPdpUrl(url);
  switch (network) {
    case "revolve":
      return parseRevolvePdp({ html });
    case "fwrd":
      return parseFwrdPdp({ html });
    case "shopbop":
      return parseShopbopPdp({ html });
    default:
      return null; // ShopMy destinations off-network land here.
  }
}
