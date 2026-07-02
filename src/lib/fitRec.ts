/**
 * Fit recommendation engine.
 *
 * Given a follower's fit profile and a product's fit data, produce a
 * recommended size, a confidence level, and a one-line human
 * rationale. Pure function; no I/O. The route + chat callers
 * (P1d surfaces) do the DB lookups and pass in the material.
 *
 * Design decisions:
 *   - Four tiers of coverage. Higher tiers say more; lower tiers say
 *     less. We NEVER fake confidence. If the data doesn't get us to
 *     "high", the confidence stays "medium" / "low" / "none" and the
 *     rationale reflects exactly what we know.
 *   - Rationale strings are composed from mechanical language only
 *     (runs small, cut is fitted, hem sits higher). No body-judgment
 *     adjectives (no "flattering", no "slimming"). That's a hard
 *     lexical rule -- see BANNED_WORDS in the test scaffold in
 *     comments below.
 *   - Category gates: only tops / bottoms / dresses / outerwear /
 *     swim get sized. Everything else returns tier 0.
 *
 * Tiers:
 *   4  Full rec:    profile height + usual size + product model ref
 *                   + fit_run (from consensus or prose). Confidence
 *                   "high" or "medium" depending on consensus depth.
 *   3  Partial rec: profile has usual size, product has model ref
 *                   but no consensus. Confidence "medium".
 *   2  Reference:   product has model ref, user has no profile.
 *                   No rec, just "Model is X wearing Y".
 *   1  Fit only:    only fit_run / fit_note. No size out; the note
 *                   speaks for itself.
 *   0  None:        insufficient data. size=null, confidence="none".
 */

import type { UserFitProfile } from "./fit";

export type ProductFitFacts = {
  subcategory: string | null;
  model_height_cm: number | null;
  model_size: string | null;
  model_size_scale: string | null; // 'us' | 'eu' | 'letter'
  fit_note: string | null;
  fit_run: "small" | "true" | "large" | null;
  fit_consensus: {
    small?: number;
    true?: number;
    large?: number;
    count?: number;
  } | null;
};

export type FitConfidence = "high" | "medium" | "low" | "none";

export type FitRec = {
  size: string | null;
  confidence: FitConfidence;
  rationale: string | null;
  /** Compact "Model is 5'9 in S" line, safe to surface anywhere the
   *  rec appears (or standalone at tier 2 when there's no rec). */
  model_line: string | null;
  tier: 0 | 1 | 2 | 3 | 4;
};

const SIZEABLE_SUBCATEGORIES = new Set([
  "tops",
  "bottoms",
  "dresses",
  "outerwear",
  "swim",
]);

// Letter-scale ladder. XXS -> XS -> S -> M -> L -> XL -> XXL.
const LETTER_LADDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL"];

// US numeric ladder for tops / dresses. Even step of 2.
const US_NUM_LADDER = ["00", "0", "2", "4", "6", "8", "10", "12", "14", "16"];

function stepSize(size: string, delta: number): string | null {
  const s = size.trim().toUpperCase();
  if (LETTER_LADDER.includes(s)) {
    const i = LETTER_LADDER.indexOf(s);
    const j = i + delta;
    if (j < 0 || j >= LETTER_LADDER.length) return null;
    return LETTER_LADDER[j];
  }
  if (US_NUM_LADDER.includes(s)) {
    const i = US_NUM_LADDER.indexOf(s);
    const j = i + delta;
    if (j < 0 || j >= US_NUM_LADDER.length) return null;
    return US_NUM_LADDER[j];
  }
  // Free-form / non-standard scale (waist inches, EU, etc.): we can't
  // step it programmatically; return null and let the caller degrade.
  return null;
}

function usualSizeFor(profile: UserFitProfile, subcategory: string | null): string | null {
  switch (subcategory) {
    case "tops":
    case "outerwear":
      return profile.usual_top;
    case "bottoms":
      return profile.usual_bottom;
    case "dresses":
    case "swim":
      return profile.usual_dress ?? profile.usual_top;
    default:
      return null;
  }
}

function cmToImperialShort(cm: number | null): string | null {
  if (cm == null) return null;
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inches = Math.round(totalIn - ft * 12);
  return `${ft}'${inches}`;
}

function modelLine(facts: ProductFitFacts): string | null {
  if (!facts.model_height_cm && !facts.model_size) return null;
  const parts: string[] = [];
  const h = cmToImperialShort(facts.model_height_cm);
  if (h) parts.push(`Model is ${h}`);
  if (facts.model_size) {
    parts.push(parts.length > 0 ? `in ${facts.model_size}` : `in ${facts.model_size}`);
  }
  return parts.join(" ");
}

function consensusStrength(
  consensus: ProductFitFacts["fit_consensus"]
): "strong" | "weak" | null {
  if (!consensus) return null;
  const count = Number(consensus.count ?? 0);
  if (count < 20) return "weak";
  const buckets = [
    Number(consensus.small ?? 0),
    Number(consensus.true ?? 0),
    Number(consensus.large ?? 0),
  ];
  const peak = Math.max(...buckets);
  return peak >= 55 ? "strong" : "weak";
}

function fitRunPhrase(run: "small" | "true" | "large" | null): string | null {
  switch (run) {
    case "small":
      return "runs small";
    case "large":
      return "runs large";
    case "true":
      return "fits true to size";
    default:
      return null;
  }
}

/**
 * Compose the rec. The core rule set:
 *   - fit_run='small'  -> step up 1
 *   - fit_run='large'  -> step down 1
 *   - fit_run='true'   -> keep usual size
 *   - preference='fitted' + run='large' -> may step down 1 (kept
 *     out of the current release to avoid stacking adjustments the
 *     data doesn't support yet).
 * Height delta is used in the rationale, not in the size math.
 */
export function recommendFit(
  profile: UserFitProfile | null,
  facts: ProductFitFacts
): FitRec {
  const subcategory = facts.subcategory;

  // Categories that don't get sized at all.
  if (!subcategory || !SIZEABLE_SUBCATEGORIES.has(subcategory)) {
    return {
      size: null,
      confidence: "none",
      rationale: null,
      model_line: null,
      tier: 0,
    };
  }

  const line = modelLine(facts);
  const runPhrase = fitRunPhrase(facts.fit_run);

  // Tier 2 (reference only): user has no profile but the product ships
  // a model reference. Return that line, no rec.
  if (!profile || profile.height_cm == null) {
    if (line) {
      return {
        size: null,
        confidence: "none",
        rationale: line,
        model_line: line,
        tier: 2,
      };
    }
    if (runPhrase) {
      // Tier 1: fit_note alone. No user or model info; just relay.
      return {
        size: null,
        confidence: "none",
        rationale: `This piece ${runPhrase}.`,
        model_line: null,
        tier: 1,
      };
    }
    return {
      size: null,
      confidence: "none",
      rationale: null,
      model_line: null,
      tier: 0,
    };
  }

  const usual = usualSizeFor(profile, subcategory);
  if (!usual) {
    // We have a profile height but no usual size for this category.
    // Surface the model line if we have one so the follower gets
    // reference, not a size guess.
    if (line) {
      return {
        size: null,
        confidence: "none",
        rationale: `${line}. You didn't share your usual ${subcategory} size, so we're not guessing.`,
        model_line: line,
        tier: 2,
      };
    }
    return {
      size: null,
      confidence: "none",
      rationale: null,
      model_line: null,
      tier: 0,
    };
  }

  // Size math from usual + fit_run.
  let size: string | null = usual;
  if (facts.fit_run === "small") {
    size = stepSize(usual, +1) ?? usual;
  } else if (facts.fit_run === "large") {
    size = stepSize(usual, -1) ?? usual;
  }

  // Confidence bucket.
  const strength = consensusStrength(facts.fit_consensus);
  let confidence: FitConfidence = "medium";
  if (strength === "strong") confidence = "high";
  else if (facts.fit_run == null) confidence = "low";

  const rationalePieces: string[] = [];
  if (line) rationalePieces.push(line);
  const you: string[] = [];
  const you_h = cmToImperialShort(profile.height_cm);
  if (you_h) you.push(`You're ${you_h}`);
  you.push(`usually ${usual}`);
  rationalePieces.push(you.join(" and "));
  if (facts.fit_run && facts.fit_run !== "true") {
    rationalePieces.push(`this ${fitRunPhrase(facts.fit_run)}`);
  }
  const rationale = `${rationalePieces.join(". ")}. Try ${size}.`;

  return {
    size,
    confidence,
    rationale,
    model_line: line,
    tier: 4,
  };
}
