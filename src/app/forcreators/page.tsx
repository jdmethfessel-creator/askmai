import Link from "next/link";
import type { Metadata } from "next";
import {
  VignetteAsk,
  VignetteForLess,
  VignetteStorefront,
  VignetteTryOn,
} from "../_pullsheet/DemoVignettes";
import "../_pullsheet/tokens.css";
import "./forcreators.css";

const OG_TITLE = "AskMai for creators";
const OG_DESC =
  "Your followers have questions. Your closet answers. A storefront with your closet in it, a stylist trained on your taste, and your links in every answer.";
const OG_IMAGE = "/og/forcreators.png";

export const metadata: Metadata = {
  title: OG_TITLE,
  description: OG_DESC,
  robots: { index: false, follow: false, nocache: true },
  openGraph: {
    title: OG_TITLE,
    description: OG_DESC,
    url: "https://www.askmai.co/forcreators",
    type: "website",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: OG_TITLE }],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: OG_DESC,
    images: [OG_IMAGE],
  },
};

const REQUEST_URL = "/creator-signup";

export default function ForCreatorsPage() {
  return (
    <main className="fc-root">
      <header className="fc-nav">
        <Link href="/" className="fc-wordmark">ASKMAI</Link>
        <nav className="fc-nav-right">
          <Link href="/" className="fc-nav-link">Home</Link>
          <Link href={REQUEST_URL} className="ps-btn ps-btn-primary">
            Request your storefront
          </Link>
        </nav>
      </header>

      <section className="fc-hero">
        <p className="ps-masthead-eyebrow">ASKMAI FOR CREATORS</p>
        <h1 className="fc-hero-h1">
          Your followers have questions. Your closet answers.
        </h1>
        <p className="fc-hero-sub">
          A storefront with your whole closet in it, a stylist trained
          on your taste, and your links in every answer.
        </p>
        <div className="fc-hero-cta">
          <Link href={REQUEST_URL} className="ps-btn ps-btn-primary">
            Request your storefront
          </Link>
        </div>
      </section>

      <section className="fc-problem">
        <p className="fc-problem-line">
          Every &ldquo;what size did you get?&rdquo; that goes
          unanswered is a sale you created and someone else attributed.
        </p>
      </section>

      <Row line="Everything you've shared, one link." vignette={<VignetteStorefront />} align="left" />
      <Row line="Mai answers like you would, with your links inside." vignette={<VignetteAsk />} align="right" />
      <Row line="Followers see your looks on themselves, then buy with confidence." vignette={<VignetteTryOn />} align="left" />
      <Row line="Budget followers stay in your closet instead of googling a dupe." vignette={<VignetteForLess />} align="right" />

      <section className="fc-money">
        <p className="ps-masthead-eyebrow">THE MONEY</p>
        <h2 className="fc-h2">Your links, untouched.</h2>
        <p className="fc-body">
          We never swap, wrap, or strip your affiliate links, and Mai
          never invents a recommendation. Your credibility is the
          whole business.
        </p>
      </section>

      <section className="fc-setup">
        <p className="fc-setup-line">
          Send your ShopMy or LTK link. Live in days. Works with
          ShopMy, LTK, Shopbop, Revolve, and FWRD.
        </p>
        <div className="fc-hero-cta">
          <Link href={REQUEST_URL} className="ps-btn ps-btn-primary">
            Request your storefront
          </Link>
        </div>
      </section>

      <footer className="fc-footer">
        <span className="fc-wordmark fc-wordmark-sm">ASKMAI</span>
        <a href="mailto:hi@askmai.co" className="fc-footer-link">hi@askmai.co</a>
      </footer>
    </main>
  );
}

function Row({
  line,
  vignette,
  align,
}: {
  line: string;
  vignette: React.ReactNode;
  align: "left" | "right";
}) {
  return (
    <section className={`fc-row fc-row-${align}`}>
      <p className="fc-row-line">{line}</p>
      <div className="fc-row-vig">{vignette}</div>
    </section>
  );
}
