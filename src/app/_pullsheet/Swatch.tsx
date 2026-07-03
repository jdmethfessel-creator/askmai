"use client";

/**
 * Toned swatch block. Replaces product photos in marketing demo
 * vignettes so the pull-sheet system reads without pretending a
 * real photo. Colors match the demo Jane Smith palette.
 */

const SWATCHES: Record<string, { top: string; bottom: string; accent: string }> = {
  ivory:     { top: "#F6F0E4", bottom: "#EDE3D0", accent: "#D6C9AE" },
  linen:     { top: "#E9E0CB", bottom: "#D8CBAF", accent: "#B9A67D" },
  gold:      { top: "#E4C580", bottom: "#B48D3E", accent: "#7C5C2C" },
  denim:     { top: "#5F7691", bottom: "#324258", accent: "#1E293B" },
  slate:     { top: "#8C877B", bottom: "#5B564B", accent: "#3C382F" },
  wine:      { top: "#7A2D3A", bottom: "#4C1B22", accent: "#2C0F14" },
  sand:      { top: "#D8C4A2", bottom: "#B5A17E", accent: "#7C6A48" },
  graphite:  { top: "#3F3C36", bottom: "#211F1B", accent: "#0E0D0B" },
  porcelain: { top: "#F1E9DC", bottom: "#E1D5BF", accent: "#B6A587" },
};

export default function Swatch({
  tone,
  label,
  size = "md",
}: {
  tone: keyof typeof SWATCHES | string;
  label?: string;
  size?: "sm" | "md" | "lg";
}) {
  const s = SWATCHES[tone as keyof typeof SWATCHES] ?? SWATCHES.linen;
  const initial = (label ?? "").trim().charAt(0).toUpperCase();
  const dim = size === "sm" ? 60 : size === "lg" ? "100%" : "100%";
  const aspect = size === "sm" ? undefined : "3 / 4";
  return (
    <div
      role="img"
      aria-label={label ?? "swatch"}
      style={{
        width: dim,
        aspectRatio: aspect,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "flex-start",
        background: `linear-gradient(160deg, ${s.top} 0%, ${s.bottom} 100%)`,
        border: "1px solid rgba(22,19,14,0.08)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          fontFamily: "var(--font-display)",
          fontStyle: "italic",
          fontWeight: 500,
          fontSize: size === "sm" ? 22 : 34,
          color: s.accent,
          opacity: 0.55,
          letterSpacing: "-0.02em",
        }}
      >
        {initial || "·"}
      </span>
    </div>
  );
}
