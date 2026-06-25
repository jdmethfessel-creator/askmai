/**
 * Anonymous device identity.
 *
 * The free-tier cap needs a stable identifier per device before the
 * visitor signs in. We resolve it in three steps, picking the first
 * that works:
 *
 *   1. httpOnly cookie  — the canonical id once set.
 *   2. fingerprint hash — SHA-256 over UA + the first /24 of the IP +
 *      a server secret. When the cookie is cleared we look up the
 *      previous counter row by fingerprint so the quota doesn't reset
 *      from a one-click cookie clear.
 *   3. fresh UUID       — first-ever visitor; we mint it and set the
 *      cookie on the response.
 *
 * Privacy notes:
 *  - IP is truncated to a /24 (first three IPv4 octets) before
 *    hashing, so the stored fingerprint is shared by ~256 households.
 *  - The hash is salted with SITE_FP_SECRET so it's not trivially
 *    reproducible by anyone with the server's UA log.
 *  - No raw UA, IP, or PII ever lands in the database — only the
 *    SHA-256 digest.
 */

import crypto from "crypto";
import { cookies } from "next/headers";

export const DEVICE_COOKIE_NAME = "askmai_device";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

function fingerprintSecret(): string {
  return (
    process.env.SITE_FP_SECRET ??
    // Dev fallback. In production this MUST come from env; missing
    // means every fingerprint is reproducible from public info.
    "askmai-fp-dev-fallback-set-SITE_FP_SECRET-in-env"
  );
}

function ipPrefixOf(ip: string): string {
  if (!ip) return "";
  if (ip.includes(":")) {
    // IPv6: first four hextets ≈ /64.
    return ip.split(":").slice(0, 4).join(":");
  }
  // IPv4: first three octets = /24.
  return ip.split(".").slice(0, 3).join(".");
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "";
}

export function computeFingerprint(req: Request): string {
  const ua = req.headers.get("user-agent") ?? "";
  const ipPrefix = ipPrefixOf(clientIp(req));
  return crypto
    .createHash("sha256")
    .update(`${ua}|${ipPrefix}|${fingerprintSecret()}`)
    .digest("hex");
}

export type DeviceIdentity = {
  deviceId: string;
  fingerprint: string;
  /** True when the caller needs to write the device cookie on the response. */
  isNew: boolean;
};

/**
 * Returns the device identity for this request. `lookupByFingerprint`
 * is injected so this module stays free of supabase imports; the chat
 * route passes a function that hits find_counter_by_fingerprint RPC.
 */
export async function resolveDeviceIdentity(
  req: Request,
  lookupByFingerprint: (fp: string) => Promise<{ device_id: string } | null>
): Promise<DeviceIdentity> {
  const fingerprint = computeFingerprint(req);
  const store = await cookies();
  const cookieValue = store.get(DEVICE_COOKIE_NAME)?.value;

  if (cookieValue) {
    return { deviceId: cookieValue, fingerprint, isNew: false };
  }

  const existing = await lookupByFingerprint(fingerprint);
  if (existing?.device_id) {
    // Same device, cookie was cleared. Reuse the prior id; set the
    // cookie on the response so we don't retake the fingerprint path
    // every request.
    return { deviceId: existing.device_id, fingerprint, isNew: true };
  }

  return {
    deviceId: crypto.randomUUID(),
    fingerprint,
    isNew: true,
  };
}

/**
 * Set-Cookie header value the caller can splat onto the response when
 * `isNew` is true. Production-ready: HttpOnly, Secure, SameSite=Lax,
 * Path=/, one-year Max-Age.
 */
export function deviceCookieHeader(deviceId: string): string {
  const attrs = [
    `${DEVICE_COOKIE_NAME}=${encodeURIComponent(deviceId)}`,
    "HttpOnly",
    "Secure",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  return attrs.join("; ");
}
