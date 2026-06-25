/**
 * Server-side Supabase session reader.
 *
 * Uses @supabase/ssr to read the Supabase auth cookies that the magic-
 * link callback sets, then resolves to our own users row (joined by
 * email). The chat route calls getServerSession() once per request to
 * decide whether the cap gate applies.
 *
 * NOTE: depends on `@supabase/ssr` — see package.json. Until the
 * dependency is installed, this file fails to compile; that's the
 * signal to run `npm install` after the migration.
 */

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "./supabase";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export type ServerSession = {
  userId: string;
  email: string;
  subscriptionStatus: "none" | "active" | "canceled";
};

/**
 * Reads the Supabase auth cookies + joins our users row. Returns null
 * when the request is anonymous or the auth cookie is invalid.
 */
export async function getServerSession(): Promise<ServerSession | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll() {
        // Read-only path; route handlers that need to write cookies
        // (the callback) use createServerClient with a writable
        // setAll there.
      },
    },
  });

  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user?.email) return null;

  const admin = supabaseAdmin();
  const userRow = await admin
    .from("users")
    .select("id, email, subscription_status")
    .eq("email", data.user.email)
    .maybeSingle();

  if (userRow.error || !userRow.data) return null;
  const status = userRow.data.subscription_status;
  return {
    userId: userRow.data.id as string,
    email: userRow.data.email as string,
    subscriptionStatus:
      status === "active" || status === "canceled" ? status : "none",
  };
}
