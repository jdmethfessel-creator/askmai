import Link from "next/link";
import type { Metadata } from "next";
import "../_pullsheet/tokens.css";
import "./forcreators.css";

const OG_TITLE = "AskMai for creators";
const OG_DESC =
  "Your followers have questions. Your closet now answers. AskMai turns your links into a storefront with a stylist inside.";
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
    images: [
      { url: OG_IMAGE, width: 1200, height: 630, alt: OG_TITLE },
    ],
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
          Your followers have questions. Your closet now answers.
        </h1>
        <p className="fc-hero-sub">
          AskMai turns your links into a storefront with a stylist
          inside, trained on your closet, your notes, and your taste.
          It answers the questions sitting in your DMs and puts your
          paid links in every reply.
        </p>
        <div className="fc-hero-cta">
          <Link href={REQUEST_URL} className="ps-btn ps-btn-primary">
            Request your storefront
          </Link>
        </div>
      </section>

      <section className="fc-section">
        <p className="ps-masthead-eyebrow">THE PROBLEM</p>
        <h2 className="fc-h2">The link page was never the store.</h2>
        <p className="fc-body">
          The store is your comment section. It&apos;s the girl asking
          if the dress wrinkles, what size you took, and what she
          should wear it with. When those questions go unanswered, she
          googles the item, buys it somewhere unattributed, and you
          make nothing on a sale you created.
        </p>
      </section>

      <section className="fc-section">
        <p className="ps-masthead-eyebrow">WHAT YOU GET</p>
        <div className="fc-rows">
          <div className="fc-row">
            <h3 className="fc-row-h">A storefront that sounds like you.</h3>
            <p className="fc-body">
              Your own page at askmai.co/you with your whole closet on
              it. Mai learns your sizing notes, your styling rules, and
              your voice from content you&apos;ve already made. You add
              nothing to your plate.
            </p>
          </div>
          <div className="fc-row">
            <h3 className="fc-row-h">Answers with your links inside.</h3>
            <p className="fc-body">
              When a follower asks what to wear with the gold hoops,
              Mai answers the way you would and tags the pieces with
              your links. Every answer is a shoppable moment you
              didn&apos;t have to type.
            </p>
          </div>
          <div className="fc-row">
            <h3 className="fc-row-h">A fitting room for your audience.</h3>
            <p className="fc-body">
              Followers try your looks on their own photo before they
              buy. Confidence at checkout means fewer abandoned carts
              and fewer returns on your recommendations.
            </p>
          </div>
          <div className="fc-row">
            <h3 className="fc-row-h">Budget followers stay in your closet.</h3>
            <p className="fc-body">
              When the $400 piece is out of reach, Mai offers the
              closest thing you actually own at a lower price, from
              your own links. The commission that used to leak to a
              dupe search stays yours.
            </p>
          </div>
        </div>
      </section>

      <section className="fc-money">
        <p className="ps-masthead-eyebrow">THE MONEY</p>
        <h2 className="fc-h2">Your links, untouched.</h2>
        <p className="fc-body">
          We never swap, wrap, or strip your affiliate links. Your
          rates and your relationships stay exactly as they are, and
          sale alerts bring followers back through your links when
          prices drop. Mai also never invents a recommendation. If you
          don&apos;t own it, she says so, because your credibility is
          the whole business.
        </p>
      </section>

      <section className="fc-section">
        <p className="ps-masthead-eyebrow">SETUP</p>
        <h2 className="fc-h2">Live in days, not quarters.</h2>
        <p className="fc-body">
          Send us your ShopMy or LTK link and we build the storefront
          from what&apos;s already there. You approve it, post it once,
          and it works every day after.
        </p>
      </section>

      <section className="fc-close">
        <p className="ps-masthead-eyebrow">FIRST CLOSETS</p>
        <h2 className="fc-h2">The first closets are open.</h2>
        <p className="fc-body">
          We&apos;re onboarding a small number of creators by hand.
        </p>
        <div className="fc-hero-cta">
          <Link href={REQUEST_URL} className="ps-btn ps-btn-primary">
            Request your storefront
          </Link>
        </div>
      </section>

      <footer className="fc-footer">
        <span className="fc-wordmark fc-wordmark-sm">ASKMAI</span>
        <a href="mailto:hi@askmai.co" className="fc-footer-link">
          hi@askmai.co
        </a>
      </footer>
    </main>
  );
}
