import { getStore } from "@netlify/blobs";

const GRAPH_API = "https://graph.facebook.com/v22.0";
const SITE_URL = "https://deals-aholic.com";
const PAGE_ID = process.env.SHOPFORLESS_PAGE_ID || "101455682008516";

function keyFor(deal) {
  return String(deal.id || deal.asin || deal.url || "");
}

function usable(deal) {
  const title = String(deal?.title || "").trim();
  const url = String(deal?.url || "").trim();
  const image = String(deal?.image || deal?.imageUrl || "").trim();
  return Boolean(!deal?.needsReview && title.length >= 8 && !/^amazon deal$/i.test(title) && url && image);
}

function caption(deal) {
  return [
    "🔥 Deal drop!",
    deal.title,
    deal.price ? `💰 ${deal.price}${deal.originalPrice ? ` (was ${deal.originalPrice})` : ""}` : "",
    "",
    `Shop this deal: ${deal.url}`,
    `More daily deals: ${SITE_URL}`,
    "Tap the link before the price changes.",
    "",
    "#ad As an Amazon Associate, Deals-Aholic may earn from qualifying purchases.",
    "#DealsAholic #AmazonFinds #DealAlert #Deals #ShoppingDeals #Sale",
  ].join("\n").slice(0, 2100);
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body = await req.json().catch(() => ({}));
  if (!process.env.ADMIN_PASSWORD || body.password !== process.env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const token = process.env.META_SYSTEM_TOKEN;
  if (!token) throw new Error("META_SYSTEM_TOKEN is not configured");

  const latest = await getStore("deals").get("latest", { type: "json" }).catch(() => null);
  const deal = (Array.isArray(latest?.deals) ? latest.deals : [])
    .filter(usable)
    .sort((a, b) => (Number(b.discountPercent) || 0) - (Number(a.discountPercent) || 0))[0];
  if (!deal) return new Response(JSON.stringify({ error: "No eligible current deal" }), { status: 404, headers: { "Content-Type": "application/json" } });

  const cardUrl = `${SITE_URL}/api/social-card?id=${encodeURIComponent(keyFor(deal))}&v=editorial-safe-4x5`;
  const response = await fetch(`${GRAPH_API}/${PAGE_ID}/photos`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ url: cardUrl, caption: caption(deal), published: "true", access_token: token }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.error) {
    return new Response(JSON.stringify({ error: result.error?.message || "Meta did not accept the post" }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ success: true, deal: { title: deal.title, price: deal.price, url: deal.url }, facebook: result }), { headers: { "Content-Type": "application/json" } });
}

export const config = { path: "/api/test-shopforless-post" };
