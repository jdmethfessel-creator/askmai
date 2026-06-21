"use client";

import { useState } from "react";

/**
 * Renders the creator's avatar with a guaranteed fallback.
 *
 * Source path matches /[slug]/page.tsx's Avatar: src is the raw
 * creators.avatar_url (a ts*.mm.bing.net thumbnail today) rendered
 * directly into <img>, no /api/img proxy. The proxy added an extra
 * round-trip that could fail / be slow and surface as the letter-tile
 * fallback on this directory page even though the SAME url renders fine
 * on the chat header. Keeping the source identical means the photo that
 * shows on /cass also shows on the /creators tile for Cass.
 *
 * onError still flips to the colored initial tile so a broken / missing
 * image never lands in the layout.
 */
export function CreatorAvatar({
  src,
  initial,
  accent,
}: {
  src: string | null;
  initial: string;
  accent: string;
}) {
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        className="cr-card-avatar"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className="cr-card-avatar cr-card-avatar-tile"
      aria-hidden
      style={{
        background: `linear-gradient(135deg, ${accent}, ${accent}aa)`,
      }}
    >
      {initial}
    </div>
  );
}
