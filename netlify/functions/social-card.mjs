import { getStore } from "@netlify/blobs";
import sharp from "sharp";

const WIDTH = 1080;
const HEIGHT = 1350;
const ALLOWED_IMAGE_HOSTS = [
  /(^|\.)amazon\.com$/i,
  /(^|\.)amazonaws\.com$/i,
  /(^|\.)walmart\.com$/i,
  /(^|\.)walmartimages\.com$/i,
  /^deals-aholic\.com$/i,
];

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(value, max = 26, lines = 3) {
  const words = String(value || "Amazing deal").trim().split(/\s+/);
  const output = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > max && current) {
      output.push(current);
      current = word;
      if (output.length === lines - 1) break;
    } else current = candidate;
  }
  if (current && output.length < lines) output.push(current);
  if (output.length < words.length && output.length) {
    const last = output.length - 1;
    output[last] = `${output[last].slice(0, Math.max(0, max - 1))}…`;
  }
  return output;
}

function dealKey(deal) {
  return String(deal.id || deal.asin || deal.url || "");
}

function validImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ALLOWED_IMAGE_HOSTS.some((pattern) => pattern.test(url.hostname));
  } catch {
    return false;
  }
}

async function findDeal(id) {
  const store = getStore("deals");
  const latest = await store.get("latest", { type: "json" }).catch(() => null);
  const deals = Array.isArray(latest?.deals) ? latest.deals : [];
  return deals.find((deal) => dealKey(deal) === id || String(deal.asin || "") === id) || null;
}

async function productLayer(imageUrl) {
  if (!validImageUrl(imageUrl)) return null;
  try {
    const response = await fetch(imageUrl, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "DealsAholic-SocialCard/1.0", Accept: "image/*" },
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null;
    return await sharp(bytes, { failOn: "error" })
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: 860, height: 620, fit: "contain", background: "#ffffff" })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

export default async function handler(req) {
  const requestUrl = new URL(req.url);
  const id = String(requestUrl.searchParams.get("id") || "").slice(0, 180);
  if (!id) return new Response("Missing deal id", { status: 400 });

  const deal = await findDeal(id);
  if (!deal || deal.needsReview) return new Response("Deal not found", { status: 404 });

  const titleLines = wrap(deal.title, 29, 3).map(escapeXml);
  const titleSvg = titleLines
    .map((line, index) => `<text x="90" y="${882 + index * 55}" font-family="Georgia, serif" font-size="45" font-weight="700" fill="#38262a">${line}</text>`)
    .join("");
  const price = escapeXml(deal.price || "Limited-time deal");
  const original = deal.originalPrice ? `Was ${escapeXml(deal.originalPrice)}` : "Shop before it is gone";
  const base = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fffaf8"/><stop offset=".52" stop-color="#ffe3e1"/><stop offset="1" stop-color="#f4c8c8"/></linearGradient>
        <linearGradient id="pill" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#d78a8d"/><stop offset="1" stop-color="#bf626b"/></linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <rect x="42" y="42" width="996" height="1266" rx="42" fill="#fffdfc" opacity=".76"/>
      <rect x="100" y="74" width="880" height="94" rx="12" fill="#d98b8d"/>
      <text x="540" y="135" text-anchor="middle" font-family="Georgia, serif" font-size="39" fill="#ffffff" letter-spacing="3">DEALS-AHOLIC FINDS</text>
      <text x="540" y="242" text-anchor="middle" font-family="Georgia, serif" font-size="35" font-weight="700" fill="#38262a" letter-spacing="2">TODAY'S DEAL</text>
      <rect x="94" y="274" width="892" height="540" rx="34" fill="#fff7f5" stroke="#efc5c4" stroke-width="3"/>
      <rect x="312" y="754" width="456" height="115" rx="58" fill="url(#pill)"/>
      <text x="540" y="833" text-anchor="middle" font-family="Georgia, serif" font-size="76" font-weight="700" fill="#ffffff">${price}</text>
      ${titleSvg}
      <text x="540" y="1086" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" fill="#73595c">${original}</text>
      <line x1="146" y1="1152" x2="934" y2="1152" stroke="#dfacae" stroke-width="2"/>
      <text x="540" y="1225" text-anchor="middle" font-family="Georgia, serif" font-size="32" fill="#38262a">Shop this deal at deals-aholic.com</text>
      <text x="540" y="1270" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="700" fill="#a56a70">LIMITED TIME • #AD</text>
    </svg>
  `);

  const product = await productLayer(deal.image || deal.imageUrl);
  const composite = product
    ? [{ input: product, left: 110, top: 245 }]
    : [];
  const jpeg = await sharp(base).composite(composite).jpeg({ quality: 90, chromaSubsampling: "4:2:0" }).toBuffer();

  return new Response(jpeg, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=86400",
    },
  });
}

export const config = { path: "/api/social-card" };
