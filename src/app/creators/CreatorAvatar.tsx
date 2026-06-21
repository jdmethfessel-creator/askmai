"use client";

import { useState } from "react";

/**
 * Renders the creator's avatar with a guaranteed fallback. If avatar_url
 * exists we proxy it through /api/img (Bing thumbnails are host-allowlisted
 * there). On any load error we drop back to the colored initial tile so the
 * card NEVER shows a broken image.
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
    const proxied = `/api/img?url=${encodeURIComponent(src)}`;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={proxied}
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
