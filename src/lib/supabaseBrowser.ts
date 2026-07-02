"use client";

/**
 * Browser-side Supabase singleton used for Realtime broadcast
 * channels. Only reads the anon key + URL, so it's safe to ship to
 * the client. Deliberately separate from `supabaseAnon` in
 * `./supabase` (which is server-only + wraps fetch with no-store)
 * because a browser singleton needs to survive across route
 * navigations without reopening the WebSocket.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let singleton: SupabaseClient | null = null;

export function supabaseBrowser(): SupabaseClient {
  if (typeof window === "undefined") {
    throw new Error("supabaseBrowser() called on the server");
  }
  if (!singleton) {
    singleton = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return singleton;
}
