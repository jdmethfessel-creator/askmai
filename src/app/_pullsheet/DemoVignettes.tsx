"use client";

/**
 * DemoVignettes - four living UI snippets composed from the REAL
 * pull-sheet components (Masthead-ish header, hang tags, chat
 * bubbles, Polaroid, For Less band) with fictional Jane Smith data.
 * These stay on-brand forever because they render the same
 * primitives as the actual product.
 *
 * Every vignette sits inside a soft editorial frame: 1px line
 * border, subtle taupe drop shadow, 12px rounded corners. That's
 * the "product glimpse" affordance so the marketing surface reads
 * as a demo, not a live surface.
 */

import { DEMO_CREATOR, DEMO_PRODUCTS, byId } from "@/lib/demoProfile";
import Swatch from "./Swatch";

function VignetteFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid var(--line)",
        boxShadow: "0 6px 22px -14px rgba(22,19,14,0.25)",
        borderRadius: 12,
        padding: 18,
        maxWidth: 460,
        margin: "0 auto",
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------
 * Vignette 1: Storefront preview - masthead + 2x2 hang tag grid
 * ------------------------------------------------------------------ */
export function VignetteStorefront() {
  const four = [
    byId("demo-ivy-linen-set")!,
    byId("demo-weekend-jean")!,
    byId("demo-estate-hoops")!,
    byId("demo-court-sneaker")!,
  ];
  return (
    <VignetteFrame>
      <div style={{ textAlign: "center", padding: "6px 0 12px" }}>
        <p className="ps-masthead-eyebrow" style={{ margin: "0 0 6px" }}>
          ASKMAI
        </p>
        <h3
          className="ps-masthead-name"
          style={{ fontSize: 22, margin: "0 0 4px" }}
        >
          {DEMO_CREATOR.name}
        </h3>
        <p className="ps-masthead-sub" style={{ fontSize: 12 }}>
          {DEMO_CREATOR.pieceCount.toLocaleString()} pieces · styled by Mai
        </p>
      </div>
      <div className="ps-tabs" style={{ margin: "8px 0 14px" }}>
        <button className="ps-tab" aria-selected="true">Shop</button>
        <button className="ps-tab" aria-selected="false">Ask</button>
        <button className="ps-tab" aria-selected="false">Try On</button>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          padding: "16px 4px 4px",
        }}
      >
        {four.map((p) => (
          <article
            key={p.id}
            className="ps-hang"
            style={{ marginTop: 14, padding: "10px 8px 10px" }}
          >
            <span className="ps-hang-string" aria-hidden />
            <span className="ps-hang-hole" aria-hidden />
            <div className="ps-hang-image-wrap" style={{ aspectRatio: "3 / 4" }}>
              <Swatch tone={p.swatch} label={p.name} />
            </div>
            <h4 className="ps-hang-name" style={{ minHeight: 26, fontSize: 11 }}>
              {p.name}
            </h4>
            <div className="ps-hang-row">
              <span className="ps-hang-network" style={{ fontSize: 7 }}>
                {DEMO_CREATOR.slug.toUpperCase()}
              </span>
              <span className="ps-hang-price" style={{ fontSize: 12 }}>
                {p.price_display}
              </span>
            </div>
          </article>
        ))}
      </div>
    </VignetteFrame>
  );
}

/* ------------------------------------------------------------------
 * Vignette 2: Ask exchange - user question, Mai reply, two mini tags
 * ------------------------------------------------------------------ */
export function VignetteAsk() {
  const ivy = byId("demo-ivy-linen-set")!;
  const hoops = byId("demo-estate-hoops")!;
  return (
    <VignetteFrame>
      <div style={{ display: "grid", gap: 10 }}>
        <div className="ps-bubble-user">
          what would Jane wear to a rooftop dinner?
        </div>
        <div className="ps-bubble-mai" style={{ paddingTop: 22, position: "relative" }}>
          <span
            className="ps-bubble-mai-eyebrow"
            style={{
              position: "absolute",
              top: 10,
              left: 14,
              margin: 0,
            }}
          >
            MAI
          </span>
          <p style={{ margin: "0 0 10px" }}>
            Fluid linen that reads dressy at dusk, a pair of gold hoops
            for the light. Sandals, hair back, done.
          </p>
          {[ivy, hoops].map((p) => (
            <div key={p.id} className="ps-hang-mini" style={{ marginTop: 8 }}>
              <div style={{ width: 60, height: 60 }}>
                <Swatch tone={p.swatch} label={p.name} size="sm" />
              </div>
              <div className="ps-hang-mini-meta">
                <span className="ps-hang-mini-name">{p.name}</span>
                <div className="ps-hang-mini-row">
                  <span className="ps-hang-mini-network">
                    {DEMO_CREATOR.slug.toUpperCase()}
                  </span>
                  <span className="ps-hang-mini-price">{p.price_display}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </VignetteFrame>
  );
}

/* ------------------------------------------------------------------
 * Vignette 3: Polaroid try-on frame + scrawl note
 * ------------------------------------------------------------------ */
export function VignetteTryOn() {
  const slip = byId("demo-marlow-slip")!;
  return (
    <VignetteFrame>
      <div
        style={{
          display: "grid",
          placeItems: "center",
          padding: "8px 0",
        }}
      >
        <div
          style={{
            background: "#ffffff",
            padding: "12px 12px 46px",
            boxShadow: "0 8px 24px -12px rgba(22,19,14,0.35)",
            transform: "rotate(-1.5deg)",
            position: "relative",
            border: "1px solid var(--line)",
            maxWidth: 240,
            width: "100%",
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -12,
              left: "50%",
              transform: "translateX(-50%) rotate(-2deg)",
              width: 96,
              height: 20,
              background: "rgba(230,220,204,0.55)",
              border: "1px dashed rgba(22,19,14,0.1)",
            }}
            aria-hidden
          />
          <div style={{ aspectRatio: "9 / 16", overflow: "hidden" }}>
            <Swatch tone={slip.swatch} label={slip.name} />
          </div>
          <p
            style={{
              position: "absolute",
              bottom: 8,
              left: 12,
              right: 12,
              textAlign: "center",
              fontFamily: "var(--font-hand)",
              fontSize: 14,
              color: "var(--graphite)",
              transform: "rotate(-1deg)",
              margin: 0,
              lineHeight: 1,
            }}
          >
            the hem hits exactly right &nbsp;x Mai
          </p>
        </div>
      </div>
    </VignetteFrame>
  );
}

/* ------------------------------------------------------------------
 * Vignette 4: For Less band - Soiree $398, Marlow $164 below
 * ------------------------------------------------------------------ */
export function VignetteForLess() {
  const soiree = byId("demo-soiree-dress")!;
  const marlow = byId("demo-marlow-slip")!;
  return (
    <VignetteFrame>
      <article
        className="ps-hang"
        style={{ marginTop: 14, marginBottom: 10 }}
      >
        <span className="ps-hang-string" aria-hidden />
        <span className="ps-hang-hole" aria-hidden />
        <div className="ps-hang-image-wrap">
          <Swatch tone={soiree.swatch} label={soiree.name} />
        </div>
        <h4 className="ps-hang-name">{soiree.name}</h4>
        <div className="ps-hang-row">
          <span className="ps-hang-network">
            {DEMO_CREATOR.slug.toUpperCase()}
          </span>
          <span className="ps-hang-price">{soiree.price_display}</span>
        </div>
      </article>

      <hr className="ps-rule" />
      <h5
        style={{
          fontFamily: "var(--font-display)",
          fontStyle: "italic",
          fontWeight: 500,
          fontSize: 15,
          margin: "6px 0 8px",
          color: "var(--ink)",
        }}
      >
        For less, from her closet
      </h5>
      <div className="ps-hang-mini">
        <div style={{ width: 60, height: 60 }}>
          <Swatch tone={marlow.swatch} label={marlow.name} size="sm" />
        </div>
        <div className="ps-hang-mini-meta">
          <span className="ps-hang-mini-name">{marlow.name}</span>
          <div className="ps-hang-mini-row">
            <span className="ps-hang-mini-network">
              {DEMO_CREATOR.slug.toUpperCase()}
            </span>
            <span className="ps-hang-mini-price">{marlow.price_display}</span>
          </div>
        </div>
      </div>
    </VignetteFrame>
  );
}

/* Grouping export for pages that render all four in sequence with
 * alternating alignment. */
export const VIGNETTES = [
  { key: "storefront", Component: VignetteStorefront },
  { key: "ask", Component: VignetteAsk },
  { key: "tryon", Component: VignetteTryOn },
  { key: "forless", Component: VignetteForLess },
] as const;

// Ensure the tsx linter counts demo product usage even when only a
// subset lands per vignette (kept for future variant swaps).
void DEMO_PRODUCTS;
