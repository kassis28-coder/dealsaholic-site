import getDeals from "./get-deals.mjs";

const BASE_URL = "https://deals-aholic.com";
const CATEGORY_SLUGS = ["electronics", "fashion", "home", "beauty", "toys", "sports", "pets", "household"];

function escXml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dealId(deal) {
  const id = String(deal.id || deal.asin || "").trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : "";
}

function priceNumber(value) {
  const parsed = Number.parseFloat(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function validDate(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function eligibleDeal(deal) {
  const price = priceNumber(deal.price);
  const discount = Number(deal.discountPercent || 0);
  return !!dealId(deal) && !!String(deal.title || "").trim() && !!String(deal.image || "").trim()
    && price !== null && price > 0 && discount >= 0 && discount <= 95;
}

export default async function handler(req, context) {
  const today = new Date().toISOString().slice(0, 10);
  const staticPages = [
    { loc: `${BASE_URL}/`, priority: "1.0", changefreq: "hourly", lastmod: today },
    { loc: `${BASE_URL}/amazon-deals`, priority: "0.9", changefreq: "hourly", lastmod: today },
    { loc: `${BASE_URL}/walmart-deals`, priority: "0.9", changefreq: "hourly", lastmod: today },
    { loc: `${BASE_URL}/promo-codes`, priority: "0.9", changefreq: "hourly", lastmod: today },
    { loc: `${BASE_URL}/telegram-deals`, priority: "0.7", changefreq: "daily", lastmod: today },
    ...CATEGORY_SLUGS.map(slug => ({ loc: `${BASE_URL}/deals/${slug}`, priority: "0.8", changefreq: "hourly", lastmod: today })),
    { loc: `${BASE_URL}/about.html`, priority: "0.5", changefreq: "monthly" },
    { loc: `${BASE_URL}/submit.html`, priority: "0.4", changefreq: "monthly" },
    { loc: `${BASE_URL}/privacy.html`, priority: "0.3", changefreq: "yearly" },
  ];

  let dealPages = [];
  try {
    const response = await getDeals(new Request(`${BASE_URL}/api/deals`), context);
    const feed = await response.json();
    dealPages = (feed.deals || []).filter(eligibleDeal).map(deal => ({
      loc: `${BASE_URL}/d/${encodeURIComponent(dealId(deal))}`,
      priority: "0.7",
      changefreq: "daily",
      lastmod: validDate(deal.createdAt || deal.fetchedAt) || today,
    }));
  } catch (error) {
    console.error("Failed to build deal sitemap entries:", error.message);
  }

  const seen = new Set();
  const pages = [...staticPages, ...dealPages].filter(page => !seen.has(page.loc) && seen.add(page.loc));
  const entries = pages.map(page => `  <url>\n    <loc>${escXml(page.loc)}</loc>${page.lastmod ? `\n    <lastmod>${page.lastmod}</lastmod>` : ""}\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=300, stale-while-revalidate=600",
    },
  });
}

export const config = { path: "/sitemap.xml" };
