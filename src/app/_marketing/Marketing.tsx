import Link from "next/link";
import {
  VignetteAsk,
  VignetteForLess,
  VignetteStorefront,
  VignetteTryOn,
} from "../_pullsheet/DemoVignettes";
import "../_pullsheet/tokens.css";
import "./homepage.css";

/*
 * Homepage. Visual-first. No live creators here; the /creators
 * directory is the only surface that lists real creators. Every
 * demo comes from src/lib/demoProfile.ts (Jane Smith fictional).
 */

export default function Marketing() {
  return (
    <main className="hp-root">
      <header className="hp-nav">
        <Link href="/" className="hp-wordmark">ASKMAI</Link>
        <nav className="hp-nav-right">
          <Link href="/forcreators" className="hp-nav-link">For creators</Link>
          <Link href="/creators" className="ps-btn ps-btn-primary">Browse creators</Link>
        </nav>
      </header>

      <section className="hp-hero">
        <p className="ps-masthead-eyebrow">ASKMAI</p>
        <h1 className="hp-hero-h1">The closet is open.</h1>
        <p className="hp-hero-sub">
          Shop your favorite creators&apos; picks in one place, ask for
          anything, and see it on you before you buy.
        </p>
        <div className="hp-hero-cta">
          <Link href="/creators" className="ps-btn ps-btn-primary">
            Find your creator
          </Link>
        </div>
        <p className="hp-hero-tinylink">
          Are you a creator?{" "}
          <Link href="/forcreators">Get your storefront.</Link>
        </p>
      </section>

      <VignetteRow
        header="Their picks, one place."
        line="Every piece they've shared, tagged and shoppable."
        align="left"
        vignette={<VignetteStorefront />}
      />

      <VignetteRow
        header="Ask for anything."
        line="Describe the outfit or the occasion, Mai pulls it from the closet."
        align="right"
        vignette={<VignetteAsk />}
      />

      <VignetteRow
        header="See it on you."
        line="One photo, and the fitting room is yours."
        align="left"
        vignette={<VignetteTryOn />}
      />

      <VignetteRow
        header="The look for less."
        line="Love the piece, not the price? Mai finds the closest thing in the same closet."
        align="right"
        vignette={<VignetteForLess />}
      />

      <section className="hp-trust">
        <p className="hp-trust-line">
          Every tag links to the retailer. Commissions go to the
          creator, always.
        </p>
      </section>

      <section className="hp-close">
        <h2 className="hp-section-h2">Find your closet.</h2>
        <Link href="/creators" className="ps-btn ps-btn-primary">
          Browse creators
        </Link>
        <p className="hp-close-scrawl">hope this helps, x Mai</p>
      </section>

      <footer className="hp-footer">
        <span className="hp-wordmark hp-wordmark-sm">ASKMAI</span>
        <a href="mailto:hi@askmai.co" className="hp-footer-link">hi@askmai.co</a>
      </footer>
    </main>
  );
}

function VignetteRow({
  header,
  line,
  align,
  vignette,
}: {
  header: string;
  line: string;
  align: "left" | "right";
  vignette: React.ReactNode;
}) {
  return (
    <section className={`hp-row hp-row-${align}`}>
      <div className="hp-row-copy">
        <h2 className="hp-row-header">{header}</h2>
        <p className="hp-row-line">{line}</p>
      </div>
      <div className="hp-row-vig">{vignette}</div>
    </section>
  );
}
