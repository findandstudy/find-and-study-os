import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BASE_URL = (process.env.BASE_URL || "https://findandstudy.com").replace(/\/$/, "");

const LANGUAGES = [
  "en", "tr", "ar", "fr", "ru", "fa", "zh", "hi", "es", "id",
  "ur", "tk", "ky", "kk", "uz", "tg",
];

const PUBLIC_PAGES = [
  { path: "", priority: "1.0", changefreq: "weekly" },
  { path: "/about", priority: "0.8", changefreq: "monthly" },
  { path: "/programs", priority: "0.9", changefreq: "daily" },
  { path: "/countries", priority: "0.8", changefreq: "weekly" },
  { path: "/blog", priority: "0.7", changefreq: "daily" },
  { path: "/contact", priority: "0.7", changefreq: "monthly" },
];

const now = new Date().toISOString().split("T")[0];

function buildUrl(lang, pagePath) {
  return `${BASE_URL}/${lang}${pagePath}`;
}

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const urlEntries = PUBLIC_PAGES.map((page) => {
  const alternates = LANGUAGES.map((lang) =>
    `    <xhtml:link rel="alternate" hreflang="${lang}" href="${escapeXml(buildUrl(lang, page.path))}"/>`
  ).join("\n");

  const xDefault = `    <xhtml:link rel="alternate" hreflang="x-default" href="${escapeXml(buildUrl("en", page.path))}"/>`;

  return `  <url>
    <loc>${escapeXml(buildUrl("en", page.path))}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
${alternates}
${xDefault}
  </url>`;
}).join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urlEntries}
</urlset>
`;

const outDir = path.join(__dirname, "dist", "public");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "sitemap.xml"), xml, "utf-8");

console.log(`[sitemap] Generated sitemap.xml → ${BASE_URL}/sitemap.xml (${LANGUAGES.length} langs × ${PUBLIC_PAGES.length} pages)`);
