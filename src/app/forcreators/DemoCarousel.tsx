"use client";

/**
 * /forcreators demo carousel — four real captured exchanges, each
 * chosen for a different category so a non-swiping visitor still
 * understands the twin handles travel, packing, beauty, and fashion.
 *
 * Page-level display name is the generic "Hailey" (no handle), so
 * the pitch reads as a representative demo. Card content + prose are
 * still verbatim from real captures off Madison's catalog — only the
 * displayed creator name is anonymized for the pitch context.
 *
 * Real content rules (per the brief):
 *   - Every slide's prose + cards come from a real chat capture, not
 *     fabricated.
 *   - Every slide leads with image-rich product cards. Slides without
 *     enough natural product breadth aren't faked.
 *   - Hotels never appear as the visual lead; they're only included on
 *     slides where they sit secondary to a strong product board. Slide
 *     1 keeps the original Mexico City restaurant text cards because
 *     the platform actually emits them with locations + Reserve/
 *     Directions actions.
 *
 * Breadth-without-swipe is solved by category tabs above the phone:
 * the four labels render up front so the user sees the surface area
 * even if they never tap a tab.
 *
 * Auto-advance: 6.5s per slide, pauses on hover or any tab click /
 * swipe so a user reading a slide doesn't lose their place.
 */

import { useEffect, useRef, useState } from "react";

type ProductCard = {
  brand: string;
  name: string;
  price: string;
  image: string;
};

type PlaceCard = {
  name: string;
  location: string;
  action: "Reserve" | "Directions" | "View";
  /** Local static asset path under /public. NEVER a live Bing thumbnail
   *  URL — those rotate. Pre-downloaded into /public/demo/<slide>/. */
  image?: string;
};

type PlaceSection = {
  label: string;
  places: PlaceCard[];
};

type Slide = {
  tab: string; // tab label above the phone
  query: string; // the user-bubble message
  prose: React.ReactNode; // the twin's voice intro
  hero: ProductCard;
  /** Optional: 2-4 product finishers under the hero. Omit on slides
   *  where the hero alone + place/hotel cards tell the story (e.g.
   *  TRAVEL with hotel + restaurants). */
  finishers?: ProductCard[];
  /** Optional: hotel + restaurant text+photo cards. Render BELOW the
   *  hero / finishers so the photo product hierarchy stays first. */
  placeSections?: PlaceSection[];
};

const SLIDE_DURATION_MS = 6500;

const SLIDES: Slide[] = [
  // 1 — TRAVEL · Alaska / Girdwood. Hero is RIMOWA suitcase (the actual
  // travel anchor in the capture). No product finishers — the Alyeska +
  // Seven Glaciers + Sakura place cards (each with a locally-hosted real
  // photo) are the point of this slide. Showing the twin handles
  // travel/dining/hotels, not just products. The earlier formal gown +
  // fine jewelry mix didn't fit an Alaska trip; dropping them per
  // direction.
  {
    tab: "Travel",
    query:
      "planning an Alaska trip. need some help with the itinerary — give me a hotel, a couple restaurants, and the right suitcase",
    prose: (
      <>
        ok this is my JAM — <em>alaska</em> is so underrated as a trip and
        alyeska specifically is ELITE. layers are EVERYTHING — the temperature
        swings are real. my formula: one nice dinner outfit, basics that work
        hard, the right suitcase.
      </>
    ),
    hero: {
      brand: "RIMOWA",
      name: "Original Cabin Suitcase",
      price: "$1,450",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1765006574607"
        ),
    },
    placeSections: [
      {
        label: "Where to stay",
        places: [
          {
            name: "Alyeska Resort",
            location: "Girdwood, AK",
            action: "View",
            image: "/demo/travel/alyeska.jpg",
          },
        ],
      },
      {
        label: "Where to eat",
        places: [
          {
            name: "Seven Glaciers Restaurant",
            location: "Alyeska Resort, Girdwood",
            action: "Reserve",
            image: "/demo/travel/seven-glaciers.jpg",
          },
          {
            name: "Sakura",
            location: "Alyeska Resort, Girdwood",
            action: "Reserve",
            image: "/demo/travel/sakura.jpg",
          },
        ],
      },
    ],
  },

  // 2 — PACKING · Tulum beach (real capture from
  // "tulum beach packing — sundresses, sandals, swim, tote").
  // Beach-appropriate hero (sundress, not the formal Imani Maxi Dress
  // which is now exclusive to the FASHION slide). 1 feed-tier
  // shopmy.us image (Cult Gaia Ada Sandals) and 3 locally-hosted
  // Bing-sourced images (Reformation hero + Frankies bikini + Cult
  // Gaia Hera tote) downloaded to /public/demo/packing/ so they
  // never rotate.
  {
    tab: "Packing",
    query: "tulum beach packing — sundresses, sandals, swim, tote",
    prose: (
      <>
        tulum packing is SERIOUS business. the vibe there is{" "}
        <em>effortless</em> but like… curated effortless, you know?
        here&apos;s exactly what i&apos;d throw in the bag.
      </>
    ),
    hero: {
      brand: "Reformation",
      name: "Amara Linen Midi Dress",
      price: "$218",
      image: "/demo/packing/reformation-amara.jpg",
    },
    finishers: [
      {
        brand: "Cult Gaia",
        name: "Ada Sandals",
        price: "$398",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/pretty-prod-1754585259705"
          ),
      },
      {
        brand: "Frankies Bikinis",
        name: "Reversible String Bikini Set",
        price: "$130",
        image: "/demo/packing/frankies-bikini.jpg",
      },
      {
        brand: "Cult Gaia",
        name: "Hera Tote",
        price: "$398",
        image: "/demo/packing/cult-gaia-hera.jpg",
      },
    ],
  },

  // 3 — BEAUTY · clean-ingredient skincare (6 catalog images)
  {
    tab: "Beauty",
    query: "build me a simple clean-ingredient skincare routine",
    prose: (
      <>
        ok so my <em>travel skincare era</em> has completely taken over my actual
        life haha. i keep it tight — nothing that doesn&apos;t earn its spot in
        the bag. C E Ferulic in the morning, hydrate, moisturize, repair at
        night.
      </>
    ),
    hero: {
      brand: "SkinCeuticals",
      name: "C E Ferulic Vitamin C Serum",
      price: "$185",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1775027500571"
        ),
    },
    finishers: [
      {
        brand: "Dr. Loretta",
        name: "Gentle Hydrating Cleanser",
        price: "$6",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/pretty-prod-1760793676763"
          ),
      },
      {
        brand: "Dieux",
        name: "Instant Angel Moisturizer",
        price: "$45",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/img-product-1745434324817"
          ),
      },
      {
        brand: "Beauty of Joseon",
        name: "Day Dew Sunscreen",
        price: "$18",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/pretty-prod-1752607458805"
          ),
      },
      {
        brand: "Dieux",
        name: "Deliverance Repair Serum",
        price: "$62",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/pretty-prod-1779311904381"
          ),
      },
    ],
  },

  // 4 — FASHION · fall garden wedding guest (4 catalog images)
  {
    tab: "Fashion",
    query: "what should I wear as a guest to a fall garden wedding",
    prose: (
      <>
        ooh <em>fall garden wedding</em> is SUCH a good dress moment. midi
        length, texture or a little drama — florals still work in muted/jewel
        tones, linen or satin over cotton, and PLEASE wear a real shoe.
      </>
    ),
    hero: {
      brand: "Solace London",
      name: "The Imani Maxi Dress",
      price: "$945",
      image:
        "/api/img?url=" +
        encodeURIComponent(
          "https://static.shopmy.us/uploads/pretty-prod-1761845774367"
        ),
    },
    finishers: [
      {
        brand: "Reformation",
        name: "Balia Linen Dress",
        price: "$278",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/img-product-1751903970581"
          ),
      },
      {
        brand: "Sau Lee",
        name: "Jackson Jacquard Gown",
        price: "$595",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/pretty-prod-1778966690346"
          ),
      },
      {
        brand: "Cult Gaia",
        name: "Emilia Mini Bag",
        price: "$505",
        image:
          "/api/img?url=" +
          encodeURIComponent(
            "https://static.shopmy.us/uploads/pretty-prod-1765272997528"
          ),
      },
    ],
  },
];

export default function DemoCarousel() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;
    const t = window.setTimeout(() => {
      setActive((i) => (i + 1) % SLIDES.length);
    }, SLIDE_DURATION_MS);
    return () => window.clearTimeout(t);
  }, [active, paused]);

  // Touch-swipe handlers — the carousel reads as a phone screen, so
  // touch-swiping it left/right feels natural even though the user has
  // tabs above too. We track both axes so a mostly-vertical swipe
  // (a page-scroll attempt that crosses the phone) doesn't get
  // misread as a slide change. Only counts as a horizontal intent
  // when |dx| dominates |dy| AND clears the threshold.
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    setPaused(true);
  }
  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current == null || touchStartY.current == null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    touchStartX.current = null;
    touchStartY.current = null;
    if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      setActive((i) => {
        const next = dx < 0 ? i + 1 : i - 1;
        return (next + SLIDES.length) % SLIDES.length;
      });
    }
  }

  return (
    <div
      className="fc-carousel"
      ref={containerRef}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="fc-tabs" role="tablist" aria-label="Demo category">
        {SLIDES.map((s, i) => (
          <button
            key={s.tab}
            type="button"
            role="tab"
            aria-selected={i === active}
            className={`fc-tab ${i === active ? "fc-tab-active" : ""}`}
            onClick={() => {
              setActive(i);
              setPaused(true);
            }}
          >
            <span>{s.tab}</span>
          </button>
        ))}
      </div>

      <div
        className="fc-phone-wrap"
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div className="fc-phone-aura" aria-hidden />
        <div className="fc-phone">
          <div className="fc-phone-screen">
            <div className="fc-phone-island" aria-hidden />
            <div className="fc-phone-statusbar">
              <span>9:41</span>
              <span className="fc-status-icons" aria-hidden>
                <SignalIcon />
                <WifiIcon />
                <BatteryIcon />
              </span>
            </div>

            <div className="fc-phone-chat">
              {SLIDES.map((s, i) => (
                <div
                  key={s.tab}
                  className={`fc-slide ${i === active ? "fc-slide-active" : ""}`}
                  aria-hidden={i !== active}
                >
                  <div className="fc-msg-user">{s.query}</div>

                  <div className="fc-msg-twin">
                    <p className="fc-twin-prose">{s.prose}</p>

                    {/* Image-led product board ALWAYS comes first — the
                        top of the phone is the visual moment. */}
                    <div className="fc-board-hero">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={s.hero.image} alt="" />
                      <div className="fc-board-hero-overlay">
                        <div className="fc-board-hero-meta">
                          <span className="fc-board-hero-brand">
                            {s.hero.brand}
                          </span>
                          <h3 className="fc-board-hero-name">{s.hero.name}</h3>
                          <span className="fc-board-hero-price">
                            {s.hero.price}
                          </span>
                        </div>
                        <span className="fc-board-shop" aria-hidden>
                          Shop →
                        </span>
                      </div>
                    </div>

                    {s.finishers && s.finishers.length > 0 && (
                      <div
                        className={`fc-board-finishers fc-board-finishers-${s.finishers.length}`}
                      >
                        {s.finishers.map((f) => (
                          <article key={f.brand + f.name} className="fc-board-fin">
                            <div className="fc-board-fin-imgwrap">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={f.image} alt="" />
                            </div>
                            <div className="fc-board-fin-meta">
                              <span className="fc-board-fin-brand">{f.brand}</span>
                              <h4 className="fc-board-fin-name">{f.name}</h4>
                              <span className="fc-board-fin-price">{f.price}</span>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}

                    {/* Place / hotel sections SECONDARY, below the
                        photo board. Clean text cards with honest
                        action labels — never "Book" on a checkout we
                        don't own. */}
                    {s.placeSections?.map((section) => (
                      <div key={section.label}>
                        <p className="fc-section-label">{section.label}</p>
                        <div className="fc-place-stack">
                          {section.places.map((p) => (
                            <div
                              key={p.name}
                              className={`fc-place ${p.image ? "fc-place-photo" : ""}`}
                            >
                              {p.image && (
                                <div className="fc-place-imgwrap">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={p.image} alt="" />
                                </div>
                              )}
                              <div className="fc-place-meta">
                                <span className="fc-place-name">{p.name}</span>
                                <span className="fc-place-loc">
                                  {p.location}
                                </span>
                              </div>
                              <span
                                className={`fc-place-action fc-place-action-${p.action.toLowerCase()}`}
                              >
                                {p.action}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="fc-pips" aria-hidden>
        {SLIDES.map((s, i) => (
          <span
            key={s.tab}
            className={`fc-pip ${i === active ? "fc-pip-active" : ""}`}
          />
        ))}
      </div>
    </div>
  );
}

function SignalIcon() {
  return (
    <svg width="16" height="10" viewBox="0 0 16 10" fill="none" aria-hidden>
      <rect x="0" y="6" width="2.5" height="4" rx="0.5" fill="currentColor" />
      <rect x="4" y="4" width="2.5" height="6" rx="0.5" fill="currentColor" />
      <rect x="8" y="2" width="2.5" height="8" rx="0.5" fill="currentColor" />
      <rect x="12" y="0" width="2.5" height="10" rx="0.5" fill="currentColor" />
    </svg>
  );
}

function WifiIcon() {
  return (
    <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
      <path d="M1 3.5A9 9 0 0 1 13 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M3 5.5A6 6 0 0 1 11 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <path d="M5 7.5A3 3 0 0 1 9 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      <circle cx="7" cy="9" r="0.8" fill="currentColor" />
    </svg>
  );
}

function BatteryIcon() {
  return (
    <svg width="22" height="11" viewBox="0 0 22 11" fill="none" aria-hidden>
      <rect x="0.5" y="0.5" width="18" height="10" rx="2.5" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.5" />
      <rect x="2" y="2" width="14" height="7" rx="1.2" fill="currentColor" />
      <rect x="19.5" y="3.5" width="2" height="4" rx="0.8" fill="currentColor" />
    </svg>
  );
}
