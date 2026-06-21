"use client";

import { useState } from "react";

/**
 * Shared creator-avatar renderer used by /[slug] (chat header) and
 * /creators (directory tile). Both consumers point at the same Supabase
 * field (creators.avatar_url), route the URL through /api/img (which
 * allowlists the Bing thumbnail CDN ts*.mm.bing.net), and degrade to a
 * branded letter tile on any load failure. Same code, same behavior on
 * both pages — only sizing/shape classes differ per consumer.
 */
export function CreatorAvatar({
  src,
  initial,
  alt = "",
  imgClassName,
  tileClassName,
  tileStyle,
}: {
  src: string | null;
  initial: string;
  alt?: string;
  imgClassName: string;
  tileClassName: string;
  tileStyle: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const proxied = src ? `/api/img?url=${encodeURIComponent(src)}` : null;

  if (proxied && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={proxied}
        alt={alt}
        className={imgClassName}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className={tileClassName} aria-hidden style={tileStyle}>
      {initial}
    </div>
  );
}
