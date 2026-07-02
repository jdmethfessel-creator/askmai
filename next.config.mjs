/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // Keep @napi-rs/canvas + sharp out of the webpack bundle. Both
    // ship native .node binaries; the moment webpack tries to parse
    // them the build fails with "Module parse failed: Unexpected
    // character". Marking them external tells Next to require() them
    // at runtime from node_modules, which is exactly what the render
    // route needs.
    serverComponentsExternalPackages: ["@napi-rs/canvas", "sharp"],
    // Force the share-card font files into the /api/render serverless
    // bundle. Vercel's file tracer can't follow @napi-rs/canvas's
    // GlobalFonts.registerFromPath calls statically; without this the
    // .woff2 files would be missing in production and composeShareCard
    // would fall back to a default typeface.
    outputFileTracingIncludes: {
      "/api/render": [
        "./src/lib/render-assets/fraunces-500-normal.woff2",
        "./src/lib/render-assets/fraunces-500-italic.woff2",
        "./src/lib/render-assets/dm-sans-500-normal.woff2",
      ],
    },
  },
  // Permanent 301 from the legacy /cassdimicconew path to the new
  // /janesmith route. The page directory was renamed for a cosmetic
  // display-name change while the underlying creator stays the same;
  // any shared links to the old URL keep landing on the page.
  async redirects() {
    return [
      {
        source: "/cassdimicconew",
        destination: "/janesmith",
        permanent: true,
      },
      {
        source: "/cassdimicconew/:path*",
        destination: "/janesmith/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
