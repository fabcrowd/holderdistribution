import { writeFileSync } from "fs";
import { resolve } from "path";
import { buildSitemap, SITEMAP_BASE_URL } from "./lib/sitemap.js";
import { loadRegistry } from "./lib/projects.js";

// Landing page + one /<slug> per mapped token (config/projects.json); a project still onboarding is left out.
const slugs = loadRegistry(process.cwd())
  .filter((p: { onboarding?: boolean }) => p.onboarding !== true)
  .map((p: { slug: string }) => p.slug);
const xml = buildSitemap({ baseUrl: SITEMAP_BASE_URL, slugs, today: new Date().toISOString().split("T")[0] });

const outputPath = resolve(process.cwd(), "public/sitemap.xml");
writeFileSync(outputPath, xml);
console.log(`Sitemap generated at ${outputPath} (${slugs.length + 1} URLs)`);
