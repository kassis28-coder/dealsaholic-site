import crypto from "node:crypto";
import fs from "node:fs";
import opentype from "opentype.js";
import sharp from "sharp";
import { validImageUrl } from "./instagram-plan-utils.mjs";

export const INSTAGRAM_CARD_WIDTH = 1080;
export const INSTAGRAM_CARD_HEIGHT = 1350;
export const SQUARE_SAFE_TOP = 135;
export const SQUARE_SAFE_BOTTOM = 1215;

const serifFont = opentype.parse(fs.readFileSync(new URL("../fonts/CormorantGaramond.ttf", import.meta.url)).buffer);
const sansFont = opentype.parse(fs.readFileSync(new URL("../fonts/DMSans.ttf", import.meta.url)).buffer);

function textPath(font, value, x, y, size, options = {}) {
  const text = String(value || "");
  const width = font.getAdvanceWidth(text, size);
  const startX = options.anchor === "middle" ? x - width / 2 : options.anchor === "end" ? x - width : x;
  return `<path d="${font.getPath(text, startX, y, size, { kerning: true }).toPathData(2)}" fill="${options.fill || "#38262a"}"/>`;
}

function wrapToWidth(value, font, size, maxWidth, lines = 2) {
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
  if (output.join(" ").split(/\s+/).length < words.length && output.length) output[output.length - 1] = `${output[output.length - 1].replace(/[.…]+$/, "")}…`;
  return output;
}

async function productLayer(imageUrl, fetchImpl = fetch) {
  if (!validImageUrl(imageUrl)) throw new Error("Product image URL is not allowed");
  const response = await fetchImpl(imageUrl, {
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "DealsAholic-InstagramCreative/1.0", Accept: "image/*" },
  });
  if (!response.ok) throw new Error(`Product image download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1_000 || bytes.length > 12 * 1024 * 1024) throw new Error("Product image has an invalid file size");
  return sharp(bytes, { failOn: "error" })
    .rotate().flatten({ background: "#ffffff" })
    .resize({ width: 820, height: 390, fit: "contain", background: "#ffffff" })
    .png().toBuffer();
}

// NOTE: This renderer is a technical safe-area fallback and is not the approved
// Deals-Aholic lifestyle editorial generator. It must never be treated as the
// locked visual style or enabled for production scheduling without a separate
// editorial-style QA approval signal.
export async function renderInstagramCard(deal, options = {}) {
  if (!deal?.deal_id || !deal?.title || !deal?.source_image_url || !deal?.deal_url) throw new Error("Frozen Instagram deal is incomplete");

  if (options.approvedBuffer || (deal.editorial_style_approved && deal.approved_editorial_image_url)) {
    let source = options.approvedBuffer;
    if (!source) {
      const approvedUrl = new URL(deal.approved_editorial_image_url);
      if (approvedUrl.protocol !== "https:" || !/(^|\.)deals-aholic\.com$/i.test(approvedUrl.hostname)) throw new Error("Approved editorial creative must be hosted by Deals-Aholic");
      const response = await (options.fetchImpl || fetch)(approvedUrl, { signal: AbortSignal.timeout(15_000), headers: { Accept: "image/*" } });
      if (!response.ok) throw new Error(`Approved editorial creative download failed (${response.status})`);
      source = Buffer.from(await response.arrayBuffer());
    }
    const metadata = await sharp(source, { failOn: "error" }).metadata();
    if (metadata.width !== INSTAGRAM_CARD_WIDTH || metadata.height !== INSTAGRAM_CARD_HEIGHT) throw new Error("Approved editorial creative must be exactly 1080x1350");
    const jpeg = await sharp(source).rotate().jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer();
    return { buffer: jpeg, width: INSTAGRAM_CARD_WIDTH, height: INSTAGRAM_CARD_HEIGHT, contentType: "image/jpeg", bytes: jpeg.length, sha256: crypto.createHash("sha256").update(jpeg).digest("hex"), styleApproved: true, styleVersion: "luxury-lifestyle-editorial-v1" };
  }

  // Locked luxury editorial style from the approved references. Every required
  // element stays between y=135 and y=1215 so Instagram's centered square crop
  // cannot cut off the title, price, code, branding, or CTA.
  const titleLines = wrapToWidth(deal.title, serifFont, 54, 820);
  const titleSvg = titleLines.map((line, index) => textPath(serifFont, line, 118, 300 + index * 58, 54, { fill: "#26140f" })).join("");
  const price = String(deal.price || "Shop now");
  const original = deal.original_price ? `WAS ${deal.original_price}` : "LIMITED-TIME FIND";
  const promo = String(deal.promo_code || "").trim();
  const base = Buffer.from(`
    <svg width="1080" height="1350" viewBox="0 0 1080 1350" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#faf5ee"/><stop offset=".55" stop-color="#f1e7dc"/><stop offset="1" stop-color="#e9d9cc"/></linearGradient>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#5a493d" flood-opacity=".15"/></filter>
      </defs>
      <rect width="1080" height="1350" fill="url(#paper)"/>
      <rect x="52" y="52" width="976" height="1246" rx="18" fill="#fffaf4" stroke="#d8c4b4" stroke-width="2"/>
      ${textPath(sansFont, "DEALS-AHOLIC FINDS", 118, 182, 23, { fill: "#32170f" })}
      ${textPath(sansFont, "THE DAILY DEAL EDIT", 962, 182, 19, { anchor: "end", fill: "#a65e52" })}
      <line x1="118" y1="207" x2="962" y2="207" stroke="#cdb5a6" stroke-width="2"/>
      ${titleSvg}
      <rect x="116" y="380" width="848" height="440" rx="12" fill="#ffffff" filter="url(#shadow)"/>
      <rect x="116" y="848" width="848" height="2" fill="#d4c0b2"/>
      ${textPath(sansFont, original, 118, 905, 21, { fill: "#79685e" })}
      ${textPath(serifFont, price, 118, 1000, 84, { fill: "#32170f" })}
      ${promo ? textPath(sansFont, `CODE ${promo}`, 960, 980, 23, { anchor: "end", fill: "#ad5f53" }) : ""}
      <rect x="118" y="1042" width="844" height="64" rx="32" fill="#32170f"/>
      ${textPath(sansFont, "SHOP THIS DEAL AT DEALS-AHOLIC.COM", 540, 1085, 23, { anchor: "middle", fill: "#ffffff" })}
      ${textPath(sansFont, "COMMENT LINK FOR THE EXACT DEAL  •  #AD", 540, 1165, 18, { anchor: "middle", fill: "#79685e" })}
    </svg>
  `);

  const product = await productLayer(deal.source_image_url, options.fetchImpl);
  const jpeg = await sharp(base)
    .composite([{ input: product, left: 130, top: 405 }])
    .resize(INSTAGRAM_CARD_WIDTH, INSTAGRAM_CARD_HEIGHT, { fit: "fill" })
    .jpeg({ quality: 92, chromaSubsampling: "4:2:0" }).toBuffer();
  const metadata = await sharp(jpeg, { failOn: "error" }).metadata();
  if (metadata.width !== INSTAGRAM_CARD_WIDTH || metadata.height !== INSTAGRAM_CARD_HEIGHT || metadata.format !== "jpeg") throw new Error("Generated Instagram creative failed 1080x1350 JPEG validation");
  if (jpeg.length < 25_000) throw new Error("Generated Instagram creative is unexpectedly small");
  return { buffer: jpeg, width: metadata.width, height: metadata.height, contentType: "image/jpeg", bytes: jpeg.length, sha256: crypto.createHash("sha256").update(jpeg).digest("hex"), styleApproved: false, styleVersion: "technical-safe-area-preview" };
}
