/**
 * Brand and host registries shared by affiliate link generation and live
 * product resolution.
 */

export const BRAND_DOMAINS: Record<string, (productName: string) => string> = {
  zara: (q) =>
    `https://www.zara.com/us/en/search?searchTerm=${encodeURIComponent(q)}`,
  "& other stories": (q) =>
    `https://www.stories.com/en_usd/search.html?q=${encodeURIComponent(q)}`,
  "and other stories": (q) =>
    `https://www.stories.com/en_usd/search.html?q=${encodeURIComponent(q)}`,
  "other stories": (q) =>
    `https://www.stories.com/en_usd/search.html?q=${encodeURIComponent(q)}`,
  cos: (q) =>
    `https://www.cos.com/en_usd/search-result.html?q=${encodeURIComponent(q)}`,
  "h&m": (q) =>
    `https://www2.hm.com/en_us/search-results.html?q=${encodeURIComponent(q)}`,
  hm: (q) =>
    `https://www2.hm.com/en_us/search-results.html?q=${encodeURIComponent(q)}`,
  reformation: (q) =>
    `https://www.thereformation.com/search?q=${encodeURIComponent(q)}`,
  aritzia: (q) =>
    `https://www.aritzia.com/us/en/search?q=${encodeURIComponent(q)}`,
  sezane: (q) =>
    `https://www.sezane.com/en/search?q=${encodeURIComponent(q)}`,
  "sézane": (q) =>
    `https://www.sezane.com/en/search?q=${encodeURIComponent(q)}`,
  madewell: (q) =>
    `https://www.madewell.com/search?q=${encodeURIComponent(q)}`,
  everlane: (q) =>
    `https://www.everlane.com/search?q=${encodeURIComponent(q)}`,
  abercrombie: (q) =>
    `https://www.abercrombie.com/shop/us/search?searchPhrase=${encodeURIComponent(
      q
    )}`,
  "free people": (q) =>
    `https://www.freepeople.com/search?q=${encodeURIComponent(q)}`,

  // Home / lifestyle (all confirmed Skimlinks merchants except where noted).
  "west elm": (q) =>
    `https://www.westelm.com/search/?words=${encodeURIComponent(q)}`,
  westelm: (q) =>
    `https://www.westelm.com/search/?words=${encodeURIComponent(q)}`,
  "pottery barn": (q) =>
    `https://www.potterybarn.com/search/?words=${encodeURIComponent(q)}`,
  potterybarn: (q) =>
    `https://www.potterybarn.com/search/?words=${encodeURIComponent(q)}`,
  article: (q) =>
    `https://www.article.com/search?q=${encodeURIComponent(q)}`,
  target: (q) =>
    `https://www.target.com/s?searchTerm=${encodeURIComponent(q)}`,
  wayfair: (q) =>
    `https://www.wayfair.com/keyword.php?keyword=${encodeURIComponent(q)}`,
  "crate & barrel": (q) =>
    `https://www.crateandbarrel.com/search?query=${encodeURIComponent(q)}`,
  "crate and barrel": (q) =>
    `https://www.crateandbarrel.com/search?query=${encodeURIComponent(q)}`,
  crateandbarrel: (q) =>
    `https://www.crateandbarrel.com/search?query=${encodeURIComponent(q)}`,
  cb2: (q) =>
    `https://www.cb2.com/search?query=${encodeURIComponent(q)}`,
  "lulu and georgia": (q) =>
    `https://www.luluandgeorgia.com/search?q=${encodeURIComponent(q)}`,
  "lulu & georgia": (q) =>
    `https://www.luluandgeorgia.com/search?q=${encodeURIComponent(q)}`,
  rejuvenation: (q) =>
    `https://www.rejuvenation.com/search/?q=${encodeURIComponent(q)}`,
  schoolhouse: (q) =>
    `https://schoolhouse.com/search?q=${encodeURIComponent(q)}`,
  "mcgee & co": (q) =>
    `https://www.mcgeeandco.com/search?q=${encodeURIComponent(q)}`,
  "mcgee and co": (q) =>
    `https://www.mcgeeandco.com/search?q=${encodeURIComponent(q)}`,
  mcgeeandco: (q) =>
    `https://www.mcgeeandco.com/search?q=${encodeURIComponent(q)}`,
  "burke decor": (q) =>
    `https://www.burkedecor.com/search?q=${encodeURIComponent(q)}`,
  burkedecor: (q) =>
    `https://www.burkedecor.com/search?q=${encodeURIComponent(q)}`,
  "lamps plus": (q) =>
    `https://www.lampsplus.com/search/?q=${encodeURIComponent(q)}`,
  lampsplus: (q) =>
    `https://www.lampsplus.com/search/?q=${encodeURIComponent(q)}`,
  anthropologie: (q) =>
    `https://www.anthropologie.com/search?q=${encodeURIComponent(q)}`,
};

/** Brand → canonical host name (used to match Serper results back). */
const BRAND_HOSTS: Record<string, string> = {
  zara: "zara.com",
  "& other stories": "stories.com",
  "and other stories": "stories.com",
  "other stories": "stories.com",
  cos: "cos.com",
  "h&m": "hm.com",
  hm: "hm.com",
  reformation: "thereformation.com",
  aritzia: "aritzia.com",
  sezane: "sezane.com",
  "sézane": "sezane.com",
  madewell: "madewell.com",
  everlane: "everlane.com",
  abercrombie: "abercrombie.com",
  "free people": "freepeople.com",
  // home
  "west elm": "westelm.com",
  westelm: "westelm.com",
  "pottery barn": "potterybarn.com",
  potterybarn: "potterybarn.com",
  article: "article.com",
  target: "target.com",
  wayfair: "wayfair.com",
  "crate & barrel": "crateandbarrel.com",
  "crate and barrel": "crateandbarrel.com",
  crateandbarrel: "crateandbarrel.com",
  cb2: "cb2.com",
  "lulu and georgia": "luluandgeorgia.com",
  "lulu & georgia": "luluandgeorgia.com",
  rejuvenation: "rejuvenation.com",
  schoolhouse: "schoolhouse.com",
  "mcgee & co": "mcgeeandco.com",
  "mcgee and co": "mcgeeandco.com",
  mcgeeandco: "mcgeeandco.com",
  "burke decor": "burkedecor.com",
  burkedecor: "burkedecor.com",
  "lamps plus": "lampsplus.com",
  lampsplus: "lampsplus.com",
  anthropologie: "anthropologie.com",
};

export function brandOwnDomainHost(brand: string): string | null {
  return BRAND_HOSTS[normalizeBrand(brand)] ?? null;
}

/**
 * Luxury / contemporary brands that should stay on Cass's feed-tier
 * Mytheresa-routed pipeline. NEVER routed through Serper — their Google
 * Shopping results are noisy reseller / lookalike traffic.
 */
export const LUXURY_BRANDS = new Set(
  [
    "the row",
    "khaite",
    "toteme",
    "totême",
    "lemaire",
    "loewe",
    "saint laurent",
    "ysl",
    "alaia",
    "alaïa",
    "isabel marant",
    "acne studios",
    "dion lee",
    "the frankie shop",
    "frankie shop",
    "by far",
    "paris texas",
    "gianvito rossi",
    "victoria beckham",
    "balenciaga",
    "bottega veneta",
    "celine",
    "céline",
    "fendi",
    "givenchy",
    "prada",
    "miu miu",
    "valentino",
    "valentino garavani",
    "chloe",
    "chloé",
    "wardrobe.nyc",
    "phoebe philo",
    "sandy liang",
    "ganni",
    "dries van noten",
    "rick owens",
    "jacquemus",
    "stella mccartney",
    "tom ford",
    "ferragamo",
    "salvatore ferragamo",
    "marc jacobs",
    "rachel gilbert",
    "mugler",
    "nour hammour",
    "manolo blahnik",
    "max mara",
    "missoni",
    "pucci",
    "jennifer behr",
    "nina ricci",
    "simkhai",
    "jean paul gaultier",
    "the sei",
    "róhe",
    "rohe",
  ].map((b) => b.toLowerCase())
);

/** Alias kept for the old import path used by affiliateLinks.ts. */
export const MYTHERESA_BRANDS = LUXURY_BRANDS;

export function normalizeBrand(b: string | undefined): string {
  return (b ?? "").trim().toLowerCase();
}

export function fallbackSearchUrl(
  brand: string | undefined,
  productName: string
): string {
  const b = normalizeBrand(brand);
  const builder = BRAND_DOMAINS[b];
  if (builder) return builder(productName);
  if (LUXURY_BRANDS.has(b)) {
    const q = [brand, productName].filter(Boolean).join(" ");
    return `https://www.mytheresa.com/en-us/search?q=${encodeURIComponent(q)}`;
  }
  const q = [brand, productName].filter(Boolean).join(" ");
  return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`;
}
