"use client";

/**
 * MaiNote - Caveat handwriting slot. Used inline on hang tags,
 * inside Ask bubbles, or standalone with a sign-off. Never
 * fabricates content: only renders when children are non-empty.
 */

import type { ReactNode } from "react";

export default function MaiNote({
  children,
  size = "sm",
  withSignoff = false,
  className = "",
}: {
  children?: ReactNode;
  size?: "sm" | "lg";
  withSignoff?: boolean;
  className?: string;
}) {
  if (!children) return null;
  const cls = `ps-mai-note ${size === "lg" ? "ps-mai-note-lg" : ""} ${className}`.trim();
  return (
    <p className={cls}>
      {children}
      {withSignoff ? <span className="ps-mai-note-sign">x Mai</span> : null}
    </p>
  );
}
