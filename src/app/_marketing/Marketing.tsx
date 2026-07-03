import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import "../_pullsheet/tokens.css";
import "./homepage.css";

type CreatorCard = {
  slug: string;
  name: string;
  count: number;
};

async function loadFeaturedCreators(): Promise<CreatorCard[]> {
  try {
    const sb = supabaseAdmin();
    const cr = await sb
      .from("creators")
      .select("id, slug, name, hidden")
      .order("created_at", { ascending: false });
    let creators = ((cr.data as { id: string; slug: string; name: string; hidden: boolean | null }[]) ?? [])
      .filter((c) => !c.hidden);
    if (creators.length === 0) {
      const fallback = await sb
        .from("creators")
        .select("id, slug, name")
        .order("created_at", { ascending: false });
      creators = ((fallback.data as { id: string; slug: string; name: string }[]) ?? []).map((c) => ({
        ...c,
        hidden: false,
      }));
    }
    const results: CreatorCard[] = [];
    for (const c of creators.slice(0, 8)) {
      const { count } = await sb
        .from("creator_products")
        .select("id", { count: "exact", head: true })
        .eq("creator_id", c.id);
      results.push({ slug: c.slug, name: c.name, count: count ?? 0 });
    }
    return results;
  } catch {
    return [];
  }
}

export default async function Marketing() {
  const creators = await loadFeaturedCreators();

  return (
    <main className="hp-root">
      <header className="hp-nav">
        <Link href="/" className="hp-wordmark">
          ASKMAI
        </Link>
        <nav className="hp-nav-right">
          <Link href="/forcreators" className="hp-nav-link">
            For creators
          </Link>
          <Link href="/creators" className="ps-btn ps-btn-primary">
            Browse creators
          </Link>
        </nav>
      </header>

      <section className="hp-hero">
        <p className="ps-masthead-eyebrow">ASKMAI</p>
        <h1 className="hp-hero-h1">The closet is open.</h1>
        <p className="hp-hero-sub">
          Shop every piece your favorite creator actually wears, ask Mai
          anything about it, and see the look on you before you buy.
        </p>
        <div className="hp-hero-cta">
          <Link href="#closets" className="ps-btn ps-btn-primary" scroll>
            Find your creator
          </Link>
        </div>
        <p className="hp-hero-tinylink">
          Are you a creator?{" "}
          <Link href="/forcreators">Get your own storefront.</Link>
        </p>
      </section>

      <section className="hp-section hp-closets" id="closets">
        <h2 className="hp-section-h2">Open now.</h2>
        {creators.length > 0 ? (
          <ul className="hp-closets-grid">
            {creators.map((c) => (
              <li key={c.slug} className="hp-closet">
                <p className="ps-masthead-eyebrow">ASKMAI</p>
                <h3 className="hp-closet-name">{c.name}</h3>
                <p className="hp-closet-sub">
                  {c.count > 0
                    ? `${c.count.toLocaleString()} piece${c.count === 1 ? "" : "s"} · styled by Mai`
                    : "styled by Mai"}
                </p>
                <Link
                  href={`/${c.slug}`}
                  className="hp-closet-cta"
                >
                  Step inside →
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hp-empty">Closets open soon.</p>
        )}
      </section>

      <section className="hp-section hp-rooms">
        <div className="hp-room">
          <p className="ps-masthead-eyebrow">ROOM 01</p>
          <h3 className="hp-room-h3">Every piece, tagged.</h3>
          <p className="hp-room-body">
            Their whole closet in one place, pulled from the shops they
            actually use. Every tag links straight to the retailer, and
            the creator&apos;s notes are written right on the tag.
          </p>
        </div>
        <div className="hp-room">
          <p className="ps-masthead-eyebrow">ROOM 02</p>
          <h3 className="hp-room-h3">A stylist who knows the closet cold.</h3>
          <p className="hp-room-body">
            Ask Mai how your creator would style it, whether the linen
            set runs small, or what goes with the gold hoops. Mai only
            answers from what the creator actually owns, and says so
            when she doesn&apos;t.
          </p>
        </div>
        <div className="hp-room">
          <p className="ps-masthead-eyebrow">ROOM 03</p>
          <h3 className="hp-room-h3">The fitting room is your camera roll.</h3>
          <p className="hp-room-body">
            Upload one photo and see the look on you, not on a model.
            Build the outfit piece by piece before you spend a dollar.
          </p>
        </div>
      </section>

      <section className="hp-section hp-band">
        <h2 className="hp-section-h2">The look for less, from their own closet.</h2>
        <p className="hp-band-body">
          Love the piece, not the price? Mai pulls the closest thing they
          actually own at a friendlier number. And if something
          you&apos;re watching goes on sale, you&apos;ll hear about it
          first.
        </p>
      </section>

      <section className="hp-section hp-look">
        <h2 className="hp-section-h2">Every outfit becomes a pull sheet.</h2>
        <p className="hp-look-body">
          Save a look and Mai lays it out the way a stylist would,
          itemized, priced, and ready to send to the group chat.
        </p>
        <div className="hp-look-sample" aria-hidden>
          <div className="hp-look-sample-eyebrow">
            <span>PULL SHEET</span>
            <span>LOOK Nº 042</span>
          </div>
          <div className="hp-look-sample-rows">
            <div className="hp-look-sample-row">
              <span>Linen slip dress</span>
              <span>$258</span>
            </div>
            <div className="hp-look-sample-row">
              <span>Woven mule</span>
              <span>$185</span>
            </div>
            <div className="hp-look-sample-row">
              <span>Small woven pouch</span>
              <span>$78</span>
            </div>
          </div>
          <div className="hp-look-sample-total">
            <span>Total</span>
            <strong>$521</strong>
          </div>
        </div>
      </section>

      <section className="hp-section hp-trust">
        <p className="hp-trust-line">
          Every tag links to where they actually shop. Commissions go to
          the creator, always.
        </p>
        <p className="hp-trust-row">Revolve · Shopbop · FWRD · ShopMy</p>
      </section>

      <section className="hp-section hp-close">
        <h2 className="hp-section-h2">Find your closet.</h2>
        <Link href="/creators" className="ps-btn ps-btn-primary">
          Browse creators
        </Link>
        <p className="hp-close-scrawl">hope this helps, x Mai</p>
      </section>

      <footer className="hp-footer">
        <span className="hp-wordmark hp-wordmark-sm">ASKMAI</span>
        <a href="mailto:hi@askmai.co" className="hp-footer-link">
          hi@askmai.co
        </a>
      </footer>
    </main>
  );
}
