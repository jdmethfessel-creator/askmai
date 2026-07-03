/**
 * GET /api/watch/unsubscribe?token=...
 *
 * One-click unsubscribe from the sale-alert email. Deletes the watch
 * row that owns the token. Never 500s; unknown tokens land on a
 * "you're unsubscribed" copy so a stale link doesn't leak whether
 * the token was ever valid.
 */

import { removeWatchByToken } from "@/lib/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = (url.searchParams.get("token") ?? "").trim();
  if (token) {
    await removeWatchByToken(token);
  }
  return new Response(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribed</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:60px 20px;background:#FAF7F1;font-family:'Space Grotesk',system-ui,sans-serif;color:#16130E;text-align:center;">
  <div style="max-width:420px;margin:0 auto;">
    <div style="font-size:9px;letter-spacing:0.34em;text-transform:uppercase;color:#7C5C2C;font-weight:500;margin-bottom:16px;">ASKMAI</div>
    <h1 style="font-family:'Bodoni Moda',Georgia,serif;font-weight:700;font-size:28px;line-height:1.15;margin:0 0 12px;">You're unsubscribed.</h1>
    <p style="font-size:15px;color:#5C5546;line-height:1.5;margin:0;">No more sale emails for that piece. You can still watch other pieces from any hang tag.</p>
    <a href="/" style="display:inline-block;margin-top:24px;padding:12px 22px;background:#16130E;color:#FAF7F1;text-decoration:none;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;border:1.5px solid #16130E;">Back to AskMai</a>
  </div>
</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}
