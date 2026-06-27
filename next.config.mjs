/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Force the bundled Inter TTFs into the /api/render serverless
  // bundle. Vercel's file tracer doesn't follow runtime `fs.readFile`
  // paths automatically; without this the font files would be missing
  // in production and sharp.text() would fall back to tofu boxes.
  outputFileTracingIncludes: {
    "/api/render": [
      "./src/lib/render-assets/Inter-Bold.ttf",
      "./src/lib/render-assets/Inter-Regular.ttf",
    ],
  },
};

export default nextConfig;
