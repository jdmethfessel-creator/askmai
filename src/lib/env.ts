/**
 * Read an env var and return the trimmed value, or undefined if the
 * var is unset OR is only whitespace after trimming. Solves the
 * class of bug where a copy-paste into the Vercel env UI carries a
 * trailing space ("price_…XY " instead of "price_…XY") which then
 * fails downstream with opaque errors like Stripe "No such price."
 *
 * Use anywhere a stray whitespace character in an env value would
 * break the integration — Stripe price IDs, API keys, webhook
 * secrets, coupon IDs, etc.
 *
 * Returns undefined (not "") so the call site can keep using
 * `if (!value)` checks idiomatically.
 */
export function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
