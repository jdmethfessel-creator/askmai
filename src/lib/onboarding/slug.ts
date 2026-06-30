/**
 * Name -> URL slug helpers for the self-serve onboarding pipeline.
 *
 * Slug rules: lowercase, ASCII-only, hyphenated, no leading or
 * trailing hyphens, no consecutive hyphens, max 48 chars. Collapses
 * any non-[a-z0-9] run to a single hyphen so accents / spaces / punct
 * all normalize. If the input has no usable characters, returns "".
 *
 * The onboarding route uses `slugify(creator.name)` as the default
 * candidate and the optional `slug_hint` from the form as an
 * override. Slug collision checking lives in the route (it needs
 * Supabase access) -- this module is pure and safe to unit test.
 */

const MAX_SLUG_LEN = 48;

export function slugify(input: string): string {
  if (!input) return "";
  // Strip combining marks (NFD then drop \p{Mn}) so "Béatrice" -> "beatrice".
  const decomposed = input.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // Lowercase, collapse any non-alphanumeric run to a single hyphen.
  const hyphenated = decomposed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return hyphenated.slice(0, MAX_SLUG_LEN);
}

/**
 * Suggest an alternative slug when the canonical candidate collides.
 * Appends -2, -3, ... up to -99 then gives up. The route uses this
 * to propose a free slug back to the form so the creator sees an
 * actionable error.
 */
export function nextFreeSlug(base: string, taken: Set<string>): string | null {
  if (!base) return null;
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, MAX_SLUG_LEN - 3)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Strict-ish validation for an operator-supplied slug_hint. Rejects
 * anything that would round-trip differently through slugify(). Saves
 * the user the surprise of typing "Jane Smith!" and getting
 * "jane-smith" without warning.
 */
export function isValidSlugHint(hint: string): boolean {
  if (!hint) return false;
  if (hint.length > MAX_SLUG_LEN) return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(hint);
}
