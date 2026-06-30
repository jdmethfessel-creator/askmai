/**
 * GET /api/admin/edit-mode?key=<value>
 * GET /api/admin/edit-mode?clear=1
 *
 * Sets or clears the edit-mode cookie used by Phase-1 curation.
 * When the `key` matches process.env.ADMIN_EDIT_KEY the route
 * issues an httpOnly cookie (askmai_edit) that subsequent
 * /api/admin/feature-product calls accept. The page server
 * component reads the same cookie to render the star toggle UI.
 *
 * The full key never lands in the browser's localStorage or any
 * scriptable surface; the cookie is httpOnly + secure +
 * sameSite=lax. It still appears once in the URL when the user
 * activates edit-mode (browser history captures it): an
 * intentional simplicity tradeoff JD signed off on for Phase 1.
 *
 * Phase 2 (creator self-serve) will drop this route entirely in
 * favor of creator-auth + ownership checks.
 */

import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDIT_COOKIE_NAME = "askmai_edit";
const COOKIE_MAX_AGE = 60 * 60 * 12; // 12 hours

export async function GET(request: Request) {
  const expected = process.env.ADMIN_EDIT_KEY;
  if (!expected) {
    return Response.json(
      { error: "admin edit key not configured" },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const clear = url.searchParams.get("clear");
  const cookieStore = await cookies();
  if (clear === "1") {
    cookieStore.delete(EDIT_COOKIE_NAME);
    return Response.json({ ok: true, cleared: true });
  }

  const key = url.searchParams.get("key");
  if (!key || key !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  cookieStore.set({
    name: EDIT_COOKIE_NAME,
    value: key,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
  return Response.json({ ok: true, edit_mode: true });
}
