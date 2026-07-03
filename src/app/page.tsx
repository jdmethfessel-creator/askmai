import type { Metadata } from "next";
import Marketing from "./_marketing/Marketing";

const OG_TITLE = "AskMai";
const OG_DESC =
  "The closet is open. Shop every piece, ask Mai anything, and see the look on you before you buy.";
const OG_IMAGE = "/og/home.png";

export const metadata: Metadata = {
  title: OG_TITLE,
  description: OG_DESC,
  openGraph: {
    title: OG_TITLE,
    description: OG_DESC,
    url: "https://www.askmai.co/",
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

export const dynamic = "force-dynamic";

export default async function Home() {
  return <Marketing />;
}
