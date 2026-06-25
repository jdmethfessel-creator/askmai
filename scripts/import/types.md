# Catalog Importer — Types

Lightweight contract between the runner and per-platform connectors.
ES modules + JSDoc, no TS — runs as a plain Node script with
`--env-file=.env.local`.

## NormalizedProduct

```js
/**
 * @typedef {Object} NormalizedProduct
 * @property {string}      name           Product title (required)
 * @property {string|null} brand          Brand / designer name (nullable)
 * @property {string|null} category       Free-text category as labeled on
 *                                        the source platform ("fashion",
 *                                        "beauty", "home" — left as-is)
 * @property {string|null} price          Price as displayed, e.g. "$280"
 *                                        (the products.price column is
 *                                        numeric — the runner parses out
 *                                        the digits before insert)
 * @property {string|null} image_url      Product photo URL (nullable)
 * @property {string}      affiliate_url  The creator's REAL attributing
 *                                        link on this platform. The
 *                                        runner refuses to insert any
 *                                        product whose URL doesn't match
 *                                        the network's expected host.
 * @property {"shopmy"|"ltk"|"travel"} network   Source-of-truth tag
 */
```

## Connector

```js
/**
 * @typedef {Object} Connector
 * @property {"shopmy"|"ltk"|"travel"} network
 * @property {(host: string) => boolean} isAttributingHost
 *   Predicate the runner uses to validate every product's
 *   affiliate_url. Reject anything that doesn't match — never insert
 *   a bare retailer URL.
 * @property {(args: { identifier: string }) => Promise<NormalizedProduct[]>}
 *   fetchProducts
 *   Given the creator's identifier on this platform (e.g. ShopMy
 *   username), return all of their published products.
 */
```

## Runner contract

`scripts/import/runner.mjs`:

```
node --env-file=.env.local scripts/import/runner.mjs \
  --creator <our-slug>            // creators.slug — used to look up creator_id
  --connector <shopmy|ltk>        // which connector to use
  --identifier <platform-handle>  // username on that platform
  [--dry-run]                     // print results, do not insert
  [--verify-count N]              // click N affiliate links after scrape
                                  // and report whether each redirect
                                  // ends on the expected host (default 2)
```

Insert path is a single `.insert()` per product (no upsert today — the
table has no per-platform unique key yet; we can add one if needed).
Existing rows for the same creator aren't touched on a re-run; use
`--reset` (not yet implemented) when we need a clean re-import.
