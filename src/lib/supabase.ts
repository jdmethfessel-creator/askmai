import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let adminSingleton: SupabaseClient | null = null;

// Next.js 13+ wraps the global `fetch` with its Data Cache by default,
// which means a supabase-js query can be served from a stale cached
// response across requests — even on a `force-dynamic` page. That broke
// the hidden-flag toggle: after flipping a creator's hidden bit, the
// page kept rendering as if the flag were still its previous value.
// Forcing `cache: "no-store"` on every fetch this client makes opts
// out of the cache so creator-visibility changes are visible on the
// next request, no redeploy or revalidate needed.
const noStoreFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, cache: "no-store" });

export function supabaseAdmin(): SupabaseClient {
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  }
  if (!adminSingleton) {
    adminSingleton = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: noStoreFetch },
    });
  }
  return adminSingleton;
}

export function supabaseAnon(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: noStoreFetch },
  });
}
