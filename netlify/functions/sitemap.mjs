import { getStore } from "@netlify/blobs";

export default async () => {
  const baseUrl = "https://deals-aholic.com";
  const store = getStore("deals");

  let data = await store.get("latest", { type: "json" });

  const staticPages = [
    "",
    "/submit.html",
    "/about.html",
    "/privacy.html"
  ];

  let urls = staticPages.map(page => `
    <url>
      <loc>${baseUrl}${page}</loc>
      <changefreq>daily</changefreq>
      <priority>0.8</priority>
    </url>
  `).join("");

  if (data && data.deals && Array.isArray(data.deals)) {
    data.deals.forEach(deal => {
      urls += `
      <url>
        <loc>${baseUrl}/deal.html?asin=${deal.asin}</loc>
        <lastmod>${deal.fetchedAt || new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.7</priority>
      </url>`;
    });
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml"
    }
  });
};
