#!/usr/bin/env node
// Byte-for-byte preservation test for affiliate URLs.
//
// PHASE 2's "Shop" button is contractually `window.open(row.affiliate_url)`
// with zero processing. This test asserts the contract at the data
// boundary: for every product parsed from the three Cass seed URLs,
// every tracking param the source page declared survives onto the
// stored affiliate_url. Run before any Phase 2 commit that touches
// outbound link logic.
//
// Pass criterion: exit 0 with "OK" on stdout.

import { ingestUrl } from "./parsers.mjs";

const CASES = [
  {
    network: "shopbop",
    url: "https://www.shopbop.com/hearts/cassdimicco/f47546d6-4053-479a-b887-bd80058a361c?extid=affprg_linkshare_SB-8yaPBDQV8ls&cvosrc=affiliate.linkshare.8yaPBDQV8ls&affuid=user-17709-pin-40272633-puser-null-src-ql&sharedid=42352&subid1=8yaPBDQV8ls-pEE2b2tdzT6vPeoFljNM0Q",
    requireParams: {
      extid: "affprg_linkshare_SB-8yaPBDQV8ls",
      cvosrc: "affiliate.linkshare.8yaPBDQV8ls",
      affuid: "user-17709-pin-40272633-puser-null-src-ql",
      sharedid: "42352",
      subid1: "8yaPBDQV8ls-pEE2b2tdzT6vPeoFljNM0Q",
    },
  },
  {
    network: "revolve",
    url: "https://www.revolve.com/content/favorites/s/cass-dimiccos-favs-3000246?source=siplt&siplt=296d0&utm_source=rev_ambassador&utm_medium=ambassador&utm_campaign=glob_b_296d0",
    requireParams: {
      siplt: "296d0",
      utm_source: "rev_ambassador",
      utm_medium: "ambassador",
      utm_campaign: "glob_b_296d0",
    },
  },
  {
    network: "fwrd",
    url: "https://www.fwrd.com/fw/PublicWishListView.jsp?email=Y2Fzc2FuZHJhZGltaWNjb0BnbWFpbC5jb20%3D&source=siplt&siplt=296d0&utm_source=rev_ambassador&utm_medium=ambassador&utm_campaign=glob_b_296d0",
    requireParams: {
      siplt: "296d0",
      utm_source: "rev_ambassador",
      utm_medium: "ambassador",
      utm_campaign: "glob_b_296d0",
    },
  },
];

let failed = 0;
let checked = 0;

for (const c of CASES) {
  const rows = await ingestUrl(c.url);
  if (rows.length === 0) {
    console.error(`FAIL ${c.network}: parser returned 0 rows`);
    failed++;
    continue;
  }
  for (const r of rows) {
    checked++;
    const u = new URL(r.affiliate_url);
    for (const [k, expected] of Object.entries(c.requireParams)) {
      const got = u.searchParams.get(k);
      if (got !== expected) {
        console.error(
          `FAIL ${c.network}/${r.source_external_id}: param ${k} expected="${expected}" got="${got}"`
        );
        failed++;
      }
    }
  }
  console.log(
    `  ${c.network}: ${rows.length} URLs checked × ${Object.keys(c.requireParams).length} params each`
  );
}

if (failed > 0) {
  console.error(`\nFAIL: ${failed} violations across ${checked} URLs`);
  process.exit(1);
}
console.log(`\nOK: ${checked} URLs preserve all affiliate params`);
