import type { Metadata } from "next";
import Link from "next/link";
import { Fraunces, Manrope } from "next/font/google";
import { supabaseAdmin } from "@/lib/supabase";
import { CreatorAvatar } from "./CreatorAvatar";
import "../_marketing/landing.css";
import "./creators.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  display: "swap",
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-display",
});

const manrope = Manrope({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "AskMai — Chat with your favorite creators",
  description:
    "Get real recommendations, in their voice, with shoppable links.",
};

export const dynamic = "force-dynamic";

type CreatorRow = {
  id: string;
  slug: string;
  name: string;
  bio: string | null;
  avatar_url: string | null;
  taste_profile: unknown;
  theme: unknown;
};

function deriveFollowers(tp: unknown): string | null {
  if (!tp || typeof tp !== "object") return null;
  const identity = (tp as Record<string, unknown>).identity;
  if (!identity || typeof identity !== "object") return null;
  const background = (identity as Record<string, unknown>).background;
  if (typeof background !== "string") return null;
  const m = background.match(
    /~?(\d+(?:\.\d+)?)\s*([KMB])\s+(?:following|followers)/i
  );
  if (!m) return null;
  return `${m[1]}${m[2].toUpperCase()} followers`;
}

function deriveHandle(tp: unknown, slug: string): string {
  if (tp && typeof tp === "object") {
    const id = (tp as Record<string, unknown>).identity;
    if (id && typeof id === "object") {
      const h = (id as Record<string, unknown>).handle;
      if (typeof h === "string" && h.length > 0) {
        return h.startsWith("@") ? h : `@${h}`;
      }
    }
  }
  return `@${slug}`;
}

function deriveAccent(theme: unknown): string {
  const fallback = "#c89863";
  if (!theme || typeof theme !== "object") return fallback;
  const a = (theme as Record<string, unknown>).accent;
  if (typeof a === "string" && /^#[0-9a-f]{3,8}$/i.test(a)) return a;
  return fallback;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

async function loadCreators(): Promise<CreatorRow[]> {
  const { data, error } = await supabaseAdmin()
    .from("creators")
    .select("id, slug, name, bio, avatar_url, taste_profile, theme")
    .order("created_at", { ascending: true });
  if (error || !data) return [];
  return data as CreatorRow[];
}

export default async function CreatorsPage() {
  const creators = await loadCreators();

  return (
    <div className={`${fraunces.variable} ${manrope.variable} askmai-landing`}>
      <main className="lp-root cr-root">
        <NoiseLayer />
        <BackgroundGlow />

        <header className="lp-nav">
          <Link href="/" className="lp-wordmark" style={{ textDecoration: "none", color: "inherit" }}>
            ask<em>mai</em>
          </Link>
          <nav className="lp-nav-right">
            <Link href="/" className="lp-nav-link">
              Home
            </Link>
            <a href="/#waitlist" className="lp-nav-cta">
              Get your twin
            </a>
          </nav>
        </header>

        <section className="cr-intro">
          <p className="lp-eyebrow">Live now</p>
          <h1 className="cr-h1">
            Chat with your favorite{" "}
            <span className="lp-accent-ink">creators.</span>
          </h1>
          <p className="cr-sub">
            Get real recommendations, in their voice, with shoppable links.
          </p>
        </section>

        <section className="cr-grid">
          {creators.map((c) => {
            const accent = deriveAccent(c.theme);
            const initial = c.name.trim().charAt(0).toUpperCase();
            const handle = deriveHandle(c.taste_profile, c.slug);
            const followers = deriveFollowers(c.taste_profile);
            const fn = firstName(c.name);
            return (
              <Link
                key={c.id}
                href={`/${c.slug}`}
                className="cr-card"
                style={{ ["--card-accent" as string]: accent }}
              >
                <CreatorAvatar
                  src={c.avatar_url}
                  initial={initial}
                  accent={accent}
                />
                <div className="cr-card-body">
                  <h2 className="cr-card-name">{c.name}</h2>
                  <p className="cr-card-handle">
                    {handle}
                    {followers ? ` · ${followers}` : ""}
                  </p>
                  {c.bio && <p className="cr-card-bio">{c.bio}</p>}
                  <span className="cr-card-cta">
                    Talk to {fn}&apos;s twin
                    <CardArrow />
                  </span>
                </div>
                <span className="cr-card-corner" aria-hidden>
                  live
                </span>
              </Link>
            );
          })}
        </section>

        {creators.length === 0 && (
          <p className="cr-empty">No creators live yet.</p>
        )}

        <footer className="lp-footer">
          <Link href="/" className="lp-wordmark lp-wordmark-sm" style={{ textDecoration: "none", color: "inherit" }}>
            ask<em>mai</em>
          </Link>
          <span className="lp-footer-note">Built in NYC + Miami.</span>
          <span className="lp-footer-meta">
            <Link href="/" className="lp-footer-link">
              Home
            </Link>
            <a href="mailto:hi@askmai.co" className="lp-footer-link">
              hi@askmai.co
            </a>
          </span>
        </footer>
      </main>
    </div>
  );
}

function CardArrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 8h10" />
      <path d="M9 4l4 4-4 4" />
    </svg>
  );
}

function NoiseLayer() {
  return (
    <svg className="lp-noise" aria-hidden xmlns="http://www.w3.org/2000/svg">
      <filter id="lp-noise-filter">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.85"
          numOctaves="2"
          stitchTiles="stitch"
        />
        <feColorMatrix
          values="0 0 0 0 0.95
                  0 0 0 0 0.91
                  0 0 0 0 0.84
                  0 0 0 0.55 0"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#lp-noise-filter)" />
    </svg>
  );
}

function BackgroundGlow() {
  return (
    <div className="lp-glow" aria-hidden>
      <div className="lp-glow-a" />
      <div className="lp-glow-b" />
    </div>
  );
}
