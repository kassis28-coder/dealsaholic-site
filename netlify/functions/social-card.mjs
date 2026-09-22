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

  const titleLines = wrapToWidth(deal.title, serifFont, 58, 900, 2);
  const titleSvg = titleLines
    .map((line, index) => textPath(serifFont, line, 540, 949 + index * 64, 58, { anchor: "middle", fill: "#342027" }))
    .join("");
  const price = String(deal.price || "Shop now");
  const original = deal.originalPrice ? `Was ${deal.originalPrice}` : "Limited-time deal";
  const base = Buffer.from(`
    <svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fffdfb"/><stop offset=".47" stop-color="#fbe7e4"/><stop offset="1" stop-color="#eec8c8"/></linearGradient>
        <linearGradient id="pill" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#d98d91"/><stop offset="1" stop-color="#b85d68"/></linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#8d5a61" flood-opacity=".17"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)"/>
      <rect x="38" y="38" width="1004" height="1274" rx="48" fill="#fffdfc" opacity=".82"/>
      <path d="M108 95 C310 50, 760 55, 972 104 L953 190 C690 151, 332 160, 128 196 Z" fill="#d68689" opacity=".94"/>
      ${textPath(serifFont, "DEALS-AHOLIC FINDS", 540, 154, 46, { anchor: "middle", fill: "#ffffff" })}
      ${textPath(sansFont, "TODAY'S DEAL", 540, 253, 27, { anchor: "middle", fill: "#8e6066" })}
      <rect x="88" y="284" width="904" height="522" rx="44" fill="#fffaf8" stroke="#efc8c4" stroke-width="3" filter="url(#shadow)"/>
      <path d="M96 799 Q540 845 984 799 L984 828 Q540 870 96 828 Z" fill="#efcdca" opacity=".8"/>
      <rect x="278" y="748" width="524" height="132" rx="66" fill="url(#pill)" filter="url(#shadow)"/>
      ${textPath(serifFont, price, 540, 839, 92, { anchor: "middle", fill: "#ffffff" })}
      ${titleSvg}
      ${textPath(sansFont, original, 540, 1096, 29, { anchor: "middle", fill: "#7e6266" })}
      <path d="M141 1155 H939" stroke="#d9a3a4" stroke-width="2"/>
      ${textPath(serifFont, "Shop this deal at deals-aholic.com", 540, 1230, 38, { anchor: "middle", fill: "#39242b" })}
      ${textPath(sansFont, "LIMITED TIME  •  #AD", 540, 1276, 20, { anchor: "middle", fill: "#aa7075" })}
    </svg>
  `);

  const product = await productLayer(deal.image || deal.imageUrl);
  const composite = product
    ? [{ input: product, left: 110, top: 248 }]
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
