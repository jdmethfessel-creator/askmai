"use client";

/**
 * Client wrapper for marketing hero images so a Server Component page
 * can still ship an onError fallback. The plate div behind the image
 * paints a cream gradient; when the src 404s (drop-in placeholder not
 * yet uploaded) the img fades to zero opacity and the plate carries
 * the layout.
 */

export default function HeroImage({
  src,
  className,
}: {
  src: string;
  className: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={className}
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.opacity = "0";
      }}
    />
  );
}
