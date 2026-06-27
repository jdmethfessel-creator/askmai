/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Force the pre-rendered branding PNGs into the /api/render
  // serverless bundle. Vercel's file tracer can't follow runtime
  // `fs.readFile(path.join(process.cwd(), …))` calls statically;
  // without this the PNGs would be missing in production and
  // applyBranding's readFile would throw EOENT.
  outputFileTracingIncludes: {
    "/api/render": [
      "./src/lib/render-assets/wordmark-askmai.png",
      "./src/lib/render-assets/url-askmai-co.png",
    ],
  },
};

export default nextConfig;
