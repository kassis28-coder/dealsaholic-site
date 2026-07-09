import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const BASE_URL = "https://deals-aholic.com";

  const staticPages = [
    { loc: `${BASE_URL}/`, priority: "1.0", changefreq: "daily" },
    { loc: `${BASE_URL}/submit.html`, priority: "0.5", changefreq: "monthly" },
    { loc: `${BASE_URL}/about.html`, priority: "0.5", changefreq: "monthly" },
    { loc: `${BASE_URL}/privacy.html`, priority: "0.5", changefreq: "monthly" },
  ];

  let dealPages = [];
  try {
    const store = getStore("deals");
    const data = await store.get("latest", { type: "json" });
    if (data && Array.isArray(data.deals) && data.deals.length > 0) {
      dealPages = data.deals
        .filter((deal) => deal.asin)
        .map((deal) => ({
          loc: `${BASE_URL}/deal.html?asin=${encodeURIComponent(deal.asin)}`,
          priority: "0.8",
          changefreq: "daily",
          lastmod: deal.fetchedAt
            ? new Date(deal.fetchedAt).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0],
        }));
    }
  } catch (err) {
    console.error("Failed to read deals blob:", err);
  }

  const allPages = [...staticPages, ...dealPages];

  const urlEntries = allPages
    .map((page) => {
      const lastmod = page.lastmod
        ? `\n    <lastmod>${page.lastmod}</lastmod>`
        : "";
      return `  <url>\n    <loc>${page.loc}</loc>${lastmod}\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`;

  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
};

export const config = {
  path: "/sitemap.xml",
};
