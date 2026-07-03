"use client";

/**
 * Masthead - centered ASKMAI eyebrow + creator name (Bodoni bold) +
 * italic subline (piece count etc.). Sits at the top of the creator
 * page above the Shop / Ask / Try On tabs.
 */

export default function Masthead({
  name,
  sub,
}: {
  name: string;
  sub?: string | null;
}) {
  return (
    <header className="ps-masthead">
      <p className="ps-masthead-eyebrow">ASKMAI</p>
      <h1 className="ps-masthead-name">{name}</h1>
      {sub ? <p className="ps-masthead-sub">{sub}</p> : null}
    </header>
  );
}
