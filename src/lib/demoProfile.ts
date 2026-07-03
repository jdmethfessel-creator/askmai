/**
 * Jane Smith demo profile - single source of truth for all
 * marketing vignettes on the homepage and /forcreators. Fictional
 * throughout: no real brand names, no retailer names, no live
 * catalog data.
 *
 * Product images are toned swatch blocks rendered inline (see
 * _pullsheet/Swatch.tsx). This keeps the marketing surface on-brand
 * without pretending a real product photo is a demo.
 */

export type DemoProduct = {
  id: string;
  name: string;
  price: number;
  price_display: string;
  category: string;
  subcategory: string;
  swatch: "ivory" | "linen" | "gold" | "denim" | "slate" | "wine" | "sand" | "graphite" | "porcelain";
};

export const DEMO_CREATOR = {
  slug: "janesmith",
  name: "Jane Smith",
  possessive: "Jane's",
  firstName: "Jane",
  pieceCount: 1209,
} as const;

export const DEMO_PRODUCTS: DemoProduct[] = [
  {
    id: "demo-ivy-linen-set",
    name: "The Ivy linen set",
    price: 128,
    price_display: "$128",
    category: "fashion",
    subcategory: "tops",
    swatch: "linen",
  },
  {
    id: "demo-estate-hoops",
    name: "Estate gold hoops",
    price: 85,
    price_display: "$85",
    category: "accessories",
    subcategory: "earrings",
    swatch: "gold",
  },
  {
    id: "demo-weekend-jean",
    name: "The Weekend jean",
    price: 148,
    price_display: "$148",
    category: "fashion",
    subcategory: "bottoms",
    swatch: "denim",
  },
  {
    id: "demo-slate-trench",
    name: "Slate trench",
    price: 220,
    price_display: "$220",
    category: "fashion",
    subcategory: "outerwear",
    swatch: "slate",
  },
  {
    id: "demo-gallery-tote",
    name: "The Gallery tote",
    price: 189,
    price_display: "$189",
    category: "accessories",
    subcategory: "bags",
    swatch: "sand",
  },
  {
    id: "demo-marlow-slip",
    name: "Marlow slip dress",
    price: 164,
    price_display: "$164",
    category: "fashion",
    subcategory: "dresses",
    swatch: "porcelain",
  },
  {
    id: "demo-soiree-dress",
    name: "The Soiree dress",
    price: 398,
    price_display: "$398",
    category: "fashion",
    subcategory: "dresses",
    swatch: "wine",
  },
  {
    id: "demo-court-sneaker",
    name: "Court sneaker",
    price: 110,
    price_display: "$110",
    category: "fashion",
    subcategory: "shoes",
    swatch: "ivory",
  },
];

export function byId(id: string): DemoProduct | undefined {
  return DEMO_PRODUCTS.find((p) => p.id === id);
}
