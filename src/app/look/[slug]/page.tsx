/**
 * /look/[slug] - pull-sheet share artifact.
 *
 * Layout matches the OG image: "PULL SHEET" eyebrow left, "LOOK Nº"
 * right, Bodoni italic title, look image, itemized dotted-rule list
 * with serif name / bronze caps source / bold price, total row,
 * "Styled by Mai x {creator}" footer with attribution.
 *
 * Every item row links to the stored affiliate URL byte-for-byte.
 */

import type { Metadata } from "next";
import Link from "next/link";
import {
  fmtPrice,
  loadLook,
  lookNumberFromSlug,
  networkLabel,
} from "@/lib/looks";
import { supabaseAdmin } from "@/lib/supabase";
import "../../_pullsheet/tokens.css";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { slug: string };

async function creatorName(slug: string): Promise<string> {
  try {
    const sb = supabaseAdmin();
    const { data } = await sb
      .from("creators")
      .select("name")
      .eq("slug", slug)
      .maybeSingle();
    return (data as { name?: string } | null)?.name ?? slug;
  } catch {
    return slug;
  }
}

export async function generateMetadata(props: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const look = await loadLook(slug);
  const title = look?.title
    ? `${look.title} · pull sheet`
    : "Pull sheet · AskMai";
  const image = `/look/${encodeURIComponent(slug.toUpperCase())}/opengraph-image`;
  return {
    title,
    description: look?.title ?? "A styled look on AskMai.",
    openGraph: {
      title,
      description: look?.title ?? "A styled look on AskMai.",
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description: look?.title ?? "A styled look on AskMai.",
      images: [image],
    },
    robots: { index: false, follow: false },
  };
}

export default async function LookPage(props: { params: Promise<Params> }) {
  const { slug } = await props.params;
  const look = await loadLook(slug);
  if (!look) {
    return (
      <main
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          padding: "40px 16px",
          background: "var(--ivory)",
          color: "var(--ink)",
          fontFamily: "var(--font-body)",
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420 }}>
          <p className="ps-eyebrow">ASKMAI</p>
          <h1 className="ps-h ps-h-lg">This pull sheet doesn&apos;t exist.</h1>
          <p style={{ color: "var(--ink-soft)", marginTop: 8 }}>
            The link may be expired or the look was removed.
          </p>
          <Link
            href="/"
            className="ps-btn ps-btn-primary"
            style={{ marginTop: 24, display: "inline-block" }}
          >
            Back home
          </Link>
        </div>
      </main>
    );
  }

  const creator = await creatorName(look.creator_slug);
  const firstName = creator.trim().split(/\s+/)[0] ?? creator;
  const lookNo = lookNumberFromSlug(look.slug);
  const hero = look.items[0]?.image_url ?? null;

  return (
    <main
      style={{
        minHeight: "100dvh",
        background: "var(--ivory)",
        color: "var(--ink)",
        fontFamily: "var(--font-body)",
        padding: "24px 16px 60px",
      }}
    >
      <article
        style={{
          maxWidth: 520,
          margin: "0 auto",
          background: "#ffffff",
          border: "1.5px solid var(--ink)",
          padding: "24px 22px 24px",
          boxShadow: "3px 3px 0 var(--taupe)",
        }}
      >
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 14,
          }}
        >
          <span
            style={{
              fontSize: 9,
              letterSpacing: "0.34em",
              textTransform: "uppercase",
              color: "var(--bronze-deep)",
              fontWeight: 600,
            }}
          >
            PULL SHEET
          </span>
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontStyle: "italic",
              fontSize: 14,
              color: "var(--ink-soft)",
            }}
          >
            LOOK Nº {lookNo}
          </span>
        </header>

        {look.title ? (
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontStyle: "italic",
              fontWeight: 500,
              fontSize: 24,
              lineHeight: 1.2,
              margin: "0 0 16px",
              color: "var(--ink)",
            }}
          >
            {look.title}
          </h1>
        ) : null}

        {hero ? (
          <div
            style={{
              background: "var(--card)",
              aspectRatio: "3 / 4",
              overflow: "hidden",
              marginBottom: 20,
              border: "1px solid var(--ink)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={hero}
              alt=""
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          </div>
        ) : null}

        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: 0,
            display: "grid",
            gap: 0,
          }}
        >
          {look.items.map((it, i) => (
            <li
              key={it.id ?? `${i}-${it.name}`}
              style={{
                display: "grid",
                gridTemplateColumns: "48px 1fr auto",
                gap: 10,
                alignItems: "center",
                padding: "10px 0",
                borderTop: i === 0 ? "1.5px solid var(--ink)" : undefined,
                borderBottom: "1px dotted var(--line)",
              }}
            >
              <a
                href={it.affiliate_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "block" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={it.image_url}
                  alt=""
                  loading="lazy"
                  style={{
                    width: 48,
                    height: 48,
                    objectFit: "cover",
                    background: "var(--card)",
                    display: "block",
                    border: "1px solid var(--line)",
                  }}
                />
              </a>
              <a
                href={it.affiliate_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  display: "grid",
                  gap: 2,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: 13,
                    lineHeight: 1.2,
                    color: "var(--ink)",
                  }}
                >
                  {it.name}
                </span>
                <span
                  style={{
                    fontSize: 8,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    color: "var(--bronze-deep)",
                    fontWeight: 600,
                  }}
                >
                  {networkLabel(it.source_network)}
                  {it.brand ? ` · ${it.brand}` : ""}
                </span>
              </a>
              <span
                style={{
                  fontWeight: 700,
                  fontSize: 13,
                  color: "var(--ink)",
                }}
              >
                {fmtPrice(it.price ?? null, it.price_display ?? null)}
              </span>
            </li>
          ))}
          {look.total != null ? (
            <li
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                padding: "12px 0 4px",
                borderTop: "1.5px solid var(--ink)",
                marginTop: 4,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-body)",
                  fontSize: 10,
                  letterSpacing: "0.18em",
                  textTransform: "uppercase",
                  color: "var(--ink-soft)",
                }}
              >
                Total
              </span>
              <strong style={{ fontSize: 15, color: "var(--ink)" }}>
                {fmtPrice(look.total)}
              </strong>
            </li>
          ) : null}
        </ul>

        <footer
          style={{
            marginTop: 24,
            paddingTop: 16,
            borderTop: "1px dotted var(--line)",
            display: "grid",
            gap: 6,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontStyle: "italic",
              fontSize: 15,
              color: "var(--ink)",
            }}
          >
            Styled by Mai × {creator}
          </div>
          <Link
            href={`/${look.creator_slug}`}
            style={{
              fontFamily: "var(--font-body)",
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--bronze-deep)",
              textDecoration: "none",
              fontWeight: 600,
            }}
          >
            askmai.co/{look.creator_slug}
          </Link>
          <div
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: "var(--ink-soft)",
              marginTop: 4,
            }}
          >
            Every tag links · commissions go to {firstName}
          </div>
        </footer>
      </article>
    </main>
  );
}
