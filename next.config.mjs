/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Force the pre-rendered share-card overlay PNG into the
  // /api/render serverless bundle. Vercel's file tracer can't
  // follow runtime `fs.readFile(path.join(process.cwd(), …))`
  // calls statically; without this the PNG would be missing in
  // production and applyBranding's readFile would throw ENOENT.
  outputFileTracingIncludes: {
    "/api/render": [
      "./src/lib/render-assets/askmai-share-overlay-1024x1536.png",
    ],
  },
};

export default nextConfig;
