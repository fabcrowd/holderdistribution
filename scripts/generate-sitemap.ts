import { writeFileSync } from "fs";
import { resolve } from "path";

// Single-route sitemap for the extracted Holders/Tokenomics site — the
// original hub's generate-sitemap.ts listed every page in the full app and
// pulled news-article dates from Supabase; neither applies here, since this
// repo only ever serves one route.
const BASE_URL = "https://holderdistribution.com";

function generateSitemap(): string {
  const today = new Date().toISOString().split("T")[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BASE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}

const outputPath = resolve(process.cwd(), "public/sitemap.xml");
writeFileSync(outputPath, generateSitemap());
console.log(`Sitemap generated at ${outputPath}`);
