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

/**
 * Hosts whose links we wrap with Skimlinks. Everything else gets unwrapped
 * (no point pretending to track a click against a merchant that isn't on
 * our affiliate network).
 */
export const IN_NETWORK_HOSTS = new Set<string>([
  "thereformation.com",
  "aritzia.com",
  "madewell.com",
  "everlane.com",
  "freepeople.com",
  "anthropologie.com",
  "sephora.com",
  "ulta.com",
  "nordstrom.com",
  "saksfifthavenue.com",
  "saks.com",
  "mytheresa.com",
  "net-a-porter.com",
  "shopbop.com",
  "revolve.com",
  "fwrd.com",
  "ssense.com",
  "farfetch.com",
  "neimanmarcus.com",
  "bloomingdales.com",
  "macys.com",
  "abercrombie.com",
  "sezane.com",
  "jcrew.com",
]);

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
