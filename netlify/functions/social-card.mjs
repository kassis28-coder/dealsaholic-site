import { getStore } from "@netlify/blobs";
import fs from "node:fs";
import opentype from "opentype.js";
import sharp from "sharp";

const WIDTH = 1080;
const HEIGHT = 1350;
const ALLOWED_IMAGE_HOSTS = [
  /(^|\.)amazon\.com$/i,
  /(^|\.)amazonaws\.com$/i,
  /(^|\.)media-amazon\.com$/i,
  /(^|\.)ssl-images-amazon\.com$/i,
  /(^|\.)walmart\.com$/i,
  /(^|\.)walmartimages\.com$/i,
  /^deals-aholic\.com$/i,
];

// Do not rely on the fonts installed in the serverless runtime. The prior
// renderer used system font names, which caused some Netlify images to render
// text as square glyphs. Convert the bundled, open-source fonts to SVG paths
// instead so every card has the intended typography on every platform.
const serifFont = opentype.parse(fs.readFileSync(new URL("../fonts/CormorantGaramond.ttf", import.meta.url)).buffer);
const sansFont = opentype.parse(fs.readFileSync(new URL("../fonts/DMSans.ttf", import.meta.url)).buffer);

function textPath(font, value, x, y, size, options = {}) {
  const text = String(value || "");
  const width = font.getAdvanceWidth(text, size);
  const startX = options.anchor === "middle" ? x - width / 2 : options.anchor === "end" ? x - width : x;
  const pathData = font.getPath(text, startX, y, size, { kerning: true }).toPathData(2);
  return `<path d="${pathData}" fill="${options.fill || "#38262a"}"${options.opacity ? ` opacity="${options.opacity}"` : ""}/>`;
}

function wrapToWidth(value, font, size, maxWidth, lines = 3) {
  const words = String(value || "Amazing deal").trim().split(/\s+/);
  const output = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.getAdvanceWidth(candidate, size) > maxWidth && current) {
      output.push(current);
      current = word;
      if (output.length === lines - 1) break;
    } else current = candidate;
  }
  if (current && output.length < lines) output.push(current);
  const usedWords = output.join(" ").split(/\s+/).length;
  if (usedWords < words.length && output.length) output[output.length - 1] = `${output[output.length - 1].replace(/[.…]+$/, "")}…`;
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

  // Editorial 4:5 layout inspired by the approved Deals-Aholic references:
  // warm neutral canvas, magazine-style typography, strong product hero, and
  // clear price hierarchy. All critical copy stays inside Instagram's square
  // preview safe area (y=135–1215).
  const titleLines = wrapToWidth(deal.title, serifFont, 58, 820, 2);
  const titleSvg = titleLines
    .map((line, index) => textPath(serifFont, line, 118, 310 + index * 64, 58, { fill: "#161616" }))
    .join("");
  const price = String(deal.price || "Shop now");
  const original = deal.originalPrice ? `WAS ${deal.originalPrice}` : "LIMITED-TIME FIND";
  const promo = String(deal.promoCode || deal.discountCode || deal.code || "").trim();
  const base = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1">
          <stop stop-color="#f6f0e7"/>
          <stop offset=".55" stop-color="#efe5d8"/>
          <stop offset="1" stop-color="#e8ddce"/>
        </linearGradient>
        <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="18" stdDeviation="24" flood-color="#5a493d" flood-opacity=".16"/>
        </filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#paper)"/>
      <rect x="52" y="52" width="976" height="1246" rx="18" fill="#fbf8f2" stroke="#d7cabd" stroke-width="2"/>
      ${textPath(sansFont, "DEALS-AHOLIC", 118, 158, 24, { fill: "#171717" })}
      ${textPath(sansFont, "THE DAILY DEAL EDIT", 962, 158, 20, { anchor: "end", fill: "#8f5f3f" })}
      <line x1="118" y1="186" x2="962" y2="186" stroke="#c9b7a7" stroke-width="2"/>
      ${titleSvg}
      <rect x="116" y="420" width="848" height="515" rx="12" fill="#ffffff" filter="url(#softShadow)"/>
      <rect x="116" y="962" width="848" height="2" fill="#d4c5b7"/>
      ${textPath(sansFont, original, 118, 1022, 22, { fill: "#7d6f64" })}
      ${textPath(serifFont, price, 118, 1128, 92, { fill: "#171717" })}
      ${promo ? textPath(sansFont, `CODE ${promo}`, 960, 1105, 24, { anchor: "end", fill: "#c86827" }) : ""}
      <rect x="118" y="1174" width="844" height="64" rx="32" fill="#171717"/>
      ${textPath(sansFont, "COMMENT LINK  •  WE'LL DM YOU THE DEAL", 540, 1217, 23, { anchor: "middle", fill: "#ffffff" })}
      ${textPath(sansFont, "SHOP MORE AT DEALS-AHOLIC.COM   •   #AD", 540, 1272, 18, { anchor: "middle", fill: "#7b6a5e" })}
    </svg>
  `);

  const product = await productLayer(deal.image || deal.imageUrl);
  // Never let the scheduler publish a blank placeholder card. A post is only
  // useful when the real, verified product visual is available.
  if (!product) return new Response("Product image is unavailable", { status: 422 });
  const composite = [{ input: product, left: 126, top: 450 }];
  // Explicitly resize the final asset to Instagram's portrait feed format.
  // This prevents accidental source-image dimensions from changing the output.
  const jpeg = await sharp(base)
    .composite(composite)
    .resize(WIDTH, HEIGHT, { fit: "fill" })
    .jpeg({ quality: 92, chromaSubsampling: "4:2:0" })
    .toBuffer();

  return new Response(jpeg, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=86400",
    },
  });
}

export const config = { path: "/api/social-card" };
