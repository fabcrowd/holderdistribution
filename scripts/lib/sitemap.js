/** Sitemap for holderdistribution.com: the landing page plus one /<slug> per mapped token. */
export function buildSitemap({ baseUrl, slugs, today }) {
  const base = baseUrl.replace(/\/+$/, "");
  const url = (loc, priority) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>daily</changefreq>
    <priority>${priority}</priority>
  </url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[url(`${base}/`, "1.0"), ...slugs.map((s) => url(`${base}/${s}`, "0.9"))].join("\n")}
</urlset>
`;
}
