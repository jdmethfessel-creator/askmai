import { ImageResponse } from "next/og";
import {
  fmtPrice,
  loadLook,
  lookNumberFromSlug,
  networkLabel,
} from "@/lib/looks";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };

const IVORY = "#FAF7F1";
const INK = "#16130E";
const INK_SOFT = "#5C5546";
const CARD = "#F1EBE0";
const TAUPE = "#E6DCCC";
const BRONZE_DEEP = "#7C5C2C";

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

export default async function OG({ params }: { params: { slug: string } }) {
  const look = await loadLook(params.slug);
  if (!look) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            background: IVORY,
            color: INK,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 40,
          }}
        >
          Pull sheet not found
        </div>
      ),
      { ...size }
    );
  }
  const creator = await creatorName(look.creator_slug);
  const lookNo = lookNumberFromSlug(look.slug);
  const hero = look.items[0]?.image_url ?? null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: IVORY,
          color: INK,
          display: "flex",
          padding: 48,
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            paddingRight: 40,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 20,
            }}
          >
            <span
              style={{
                fontSize: 14,
                letterSpacing: 6,
                textTransform: "uppercase",
                color: BRONZE_DEEP,
                fontWeight: 700,
              }}
            >
              PULL SHEET
            </span>
            <span
              style={{
                fontSize: 18,
                fontStyle: "italic",
                color: INK_SOFT,
              }}
            >
              LOOK Nº {lookNo}
            </span>
          </div>
          {look.title ? (
            <div
              style={{
                fontSize: 40,
                fontStyle: "italic",
                lineHeight: 1.15,
                color: INK,
                marginBottom: 24,
              }}
            >
              {look.title}
            </div>
          ) : null}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 12,
              flex: 1,
            }}
          >
            {look.items.slice(0, 5).map((it, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  paddingBottom: 8,
                  borderBottom: `1px dotted ${TAUPE}`,
                  fontSize: 20,
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 700, color: INK }}>{it.name}</span>
                  <span
                    style={{
                      fontSize: 12,
                      letterSpacing: 3,
                      textTransform: "uppercase",
                      color: BRONZE_DEEP,
                      fontWeight: 700,
                    }}
                  >
                    {networkLabel(it.source_network)}
                    {it.brand ? ` · ${it.brand}` : ""}
                  </span>
                </div>
                <span style={{ fontWeight: 700, color: INK }}>
                  {fmtPrice(it.price ?? null, it.price_display ?? null)}
                </span>
              </div>
            ))}
          </div>
          <div
            style={{
              marginTop: 24,
              paddingTop: 16,
              borderTop: `2px solid ${INK}`,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div
              style={{
                fontSize: 24,
                fontStyle: "italic",
                color: INK,
              }}
            >
              Styled by Mai × {creator}
            </div>
            <div
              style={{
                fontSize: 14,
                letterSpacing: 4,
                textTransform: "uppercase",
                color: INK_SOFT,
              }}
            >
              askmai.co/{look.creator_slug}
            </div>
          </div>
        </div>

        {hero ? (
          <div
            style={{
              width: 380,
              height: "100%",
              background: CARD,
              border: `2px solid ${INK}`,
              boxShadow: `4px 4px 0 ${TAUPE}`,
              overflow: "hidden",
              display: "flex",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={hero}
              alt=""
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          </div>
        ) : null}
      </div>
    ),
    { ...size }
  );
}
