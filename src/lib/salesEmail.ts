/**
 * Sale-alert email template. Renders inline HTML matching the
 * pull-sheet brand: ivory background, Bodoni serif headline, a
 * hang-tag style product block, ink-fill CTA, footer strip.
 *
 * Never uses "AI" in copy; the stylist is "Mai". No em dashes.
 */

export type SaleEmailArgs = {
  creatorFirstName: string;
  creatorSlug: string;
  productTitle: string;
  brand: string | null;
  imageUrl: string;
  affiliateUrl: string;
  oldPrice: number;
  newPrice: number;
  network: string;
  unsubscribeUrl: string;
};

function fmt(price: number): string {
  return `$${Math.round(price)}`;
}

export function renderSaleEmailHtml(args: SaleEmailArgs): string {
  const {
    creatorFirstName,
    productTitle,
    brand,
    imageUrl,
    affiliateUrl,
    oldPrice,
    newPrice,
    network,
    unsubscribeUrl,
  } = args;

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>It went on sale.</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background:#FAF7F1;font-family:'Space Grotesk',ui-sans-serif,system-ui,sans-serif;color:#16130E;-webkit-font-smoothing:antialiased;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F1;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
            <tr>
              <td align="center" style="padding-bottom:20px;">
                <div style="font-family:'Space Grotesk',sans-serif;font-size:9px;letter-spacing:0.34em;text-transform:uppercase;color:#7C5C2C;font-weight:500;">
                  ASKMAI
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding-bottom:28px;">
                <h1 style="margin:0;font-family:'Bodoni Moda',Georgia,serif;font-weight:700;font-size:34px;line-height:1.1;letter-spacing:-0.005em;color:#16130E;">
                  It went on sale.
                </h1>
              </td>
            </tr>
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #16130E;box-shadow:2.5px 2.5px 0 #E6DCCC;">
                  <tr>
                    <td style="padding:16px 14px 14px;" align="center">
                      <img src="${imageUrl}" alt="${escapeHtml(productTitle)}" width="360" style="display:block;max-width:100%;height:auto;background:#F1EBE0;" />
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:0 14px 8px;">
                      <div style="font-family:'Space Grotesk',sans-serif;font-size:8px;letter-spacing:0.12em;text-transform:uppercase;color:#7C5C2C;font-weight:600;margin-bottom:4px;">
                        ${escapeHtml(networkLabel(network))}
                        ${brand ? ` &middot; ${escapeHtml(brand)}` : ""}
                      </div>
                      <div style="font-family:'Bodoni Moda',Georgia,serif;font-weight:700;font-size:16px;line-height:1.25;color:#16130E;margin-bottom:10px;">
                        ${escapeHtml(productTitle)}
                      </div>
                      <div style="font-family:'Space Grotesk',sans-serif;font-size:14px;color:#16130E;padding-bottom:14px;">
                        <span style="text-decoration:line-through;color:#5C5546;margin-right:8px;">${fmt(oldPrice)}</span>
                        <strong style="font-weight:700;">${fmt(newPrice)}</strong>
                      </div>
                    </td>
                  </tr>
                  <tr>
                    <td align="center" style="padding:0 14px 20px;">
                      <a href="${affiliateUrl}" style="display:inline-block;background:#16130E;color:#FAF7F1;padding:12px 28px;text-decoration:none;font-family:'Space Grotesk',sans-serif;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;border:1.5px solid #16130E;">
                        Shop the sale
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 0 12px;">
                <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;color:#5C5546;letter-spacing:0.02em;line-height:1.5;">
                  Styled by Mai &middot; every tag links, commissions go to ${escapeHtml(creatorFirstName)}.
                </div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 0 20px;">
                <a href="${unsubscribeUrl}" style="font-family:'Space Grotesk',sans-serif;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#5C5546;text-decoration:underline;">
                  Unsubscribe
                </a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function networkLabel(network: string): string {
  const s = network.trim().toLowerCase();
  if (s === "shopmy") return "ShopMy";
  if (s === "shopbop") return "Shopbop";
  if (s === "revolve") return "Revolve";
  if (s === "fwrd") return "FWRD";
  return network || "";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderSaleEmailSubject(args: {
  productTitle: string;
  newPrice: number;
}): string {
  return `${args.productTitle} is on sale at ${fmt(args.newPrice)}`;
}
