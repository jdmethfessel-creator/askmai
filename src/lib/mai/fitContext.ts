/**
 * Assemble the FIT CONTEXT block Mai reads to answer "what size"
 * questions. Produces a compact text summary of:
 *   1. The viewer's fit profile (height, usual sizes, preference)
 *   2. Per-product model reference + fit note for the catalog rows
 *      currently in scope
 *
 * Kept intentionally lean: sizing questions in chat are rare enough
 * that we don't want to burn tokens quoting a full size chart per
 * product. Model reference + fit direction is enough for Mai to
 * reproduce the same mechanical rationale the /api/fit-rec endpoint
 * produces.
 */

import { supabaseAdmin } from "../supabase";
import type { UserFitProfile } from "../fit";

function cmToImperialShort(cm: number | null): string | null {
  if (cm == null) return null;
  const totalIn = cm / 2.54;
  const ft = Math.floor(totalIn / 12);
  const inches = Math.round(totalIn - ft * 12);
  return `${ft}'${inches}`;
}

function formatViewer(profile: UserFitProfile | null): string {
  if (!profile) return "  (no fit profile on file)";
  const parts: string[] = [];
  const h = cmToImperialShort(profile.height_cm);
  if (h) parts.push(`height ${h}`);
  const sizes: string[] = [];
  if (profile.usual_top) sizes.push(`tops ${profile.usual_top}`);
  if (profile.usual_bottom) sizes.push(`bottoms ${profile.usual_bottom}`);
  if (profile.usual_dress) sizes.push(`dresses ${profile.usual_dress}`);
  if (sizes.length > 0) parts.push(`usually ${sizes.join(", ")}`);
  if (profile.anchor_brand) parts.push(`anchor brand ${profile.anchor_brand}`);
  if (profile.preference) parts.push(`prefers ${profile.preference}`);
  if (parts.length === 0) return "  (no fit profile on file)";
  return `  ${parts.join("; ")}`;
}

type ProductFitRow = {
  product_id: string;
  model_height_cm: number | null;
  model_size: string | null;
  fit_note: string | null;
  fit_run: string | null;
};

export async function buildFitContextBlock(args: {
  profile: UserFitProfile | null;
  productIds: string[];
  productLabels: Map<string, string>;
}): Promise<string> {
  const { profile, productIds, productLabels } = args;
  const viewerLine = formatViewer(profile);

  if (productIds.length === 0) {
    return `VIEWER:\n${viewerLine}\n\nPRODUCT FIT DATA:\n  (none for this scope)`;
  }

  const admin = supabaseAdmin();
  const { data } = await admin
    .from("product_fit")
    .select("product_id, model_height_cm, model_size, fit_note, fit_run")
    .in("product_id", productIds);
  const rows = (data as ProductFitRow[] | null) ?? [];
  if (rows.length === 0) {
    return `VIEWER:\n${viewerLine}\n\nPRODUCT FIT DATA:\n  (none for this scope)`;
  }

  const lines = rows.map((r) => {
    const label = productLabels.get(r.product_id) ?? r.product_id;
    const bits: string[] = [];
    const mh = cmToImperialShort(r.model_height_cm);
    if (mh && r.model_size) bits.push(`model ${mh} in ${r.model_size}`);
    else if (mh) bits.push(`model ${mh}`);
    else if (r.model_size) bits.push(`model in ${r.model_size}`);
    if (r.fit_run) bits.push(`runs ${r.fit_run}`);
    if (r.fit_note) bits.push(`note: "${r.fit_note.slice(0, 140)}"`);
    return `  - ${label}: ${bits.join("; ") || "(no fit data)"}`;
  });
  return `VIEWER:\n${viewerLine}\n\nPRODUCT FIT DATA:\n${lines.join("\n")}`;
}
