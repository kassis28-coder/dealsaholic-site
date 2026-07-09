import { getStore } from "@netlify/blobs";

const PARTNER_TAG = 'kethya08-20';
const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG_ENV = process.env.AMAZON_PARTNER_TAG || PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

// ─── Amazon Creator API ────────────────────────────────────────────────────

async function getAccessToken() {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "creatorsapi::default",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    console.error('getAccessToken failed:', e.message);
    return null;
  }
}

// Search Amazon by title — returns { asin, image, title, url } or null
async function searchAmazonByTitle(title) {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return null;
    const res = await fetch(CATALOG_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "x-marketplace": MARKETPLACE,
      },
      body: JSON.stringify({
        keywords: title,
        itemCount: 1,
        partnerTag: PARTNER_TAG_ENV,
        partnerType: "Associates",
        marketplace: MARKETPLACE,
        resources: [
          "images.primary.large",
          "itemInfo.title",
          "offersV2.listings.price",
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || data.searchResult?.items || [];
    if (!items[0]) return null;
    const item = items[0];
    const asin = item.asin;
    // FIX: Only use the primary large image from the API — never /images/P/ format
    const image = item.images?.primary?.large?.url || null;
    console.log(`Title search "${title}" → ASIN ${asin}, image: ${image ? 'found' : 'missing'}`);
    return {
      asin,
      image,
      title: item.itemInfo?.title?.displayValue || null,
      url: `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG_ENV}`,
    };
  } catch (e) {
    console.error('searchAmazonByTitle failed:', e.message);
    return null;
  }
}

// ─── Amazon page scraper ───────────────────────────────────────────────────

async function followRedirectForAsin(amazonUrl) {
  try {
    const res = await fetch(amazonUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    const finalUrl = res.url || amazonUrl;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    return { asin, finalUrl };
  } catch (e) {
    return { asin: null, finalUrl: amazonUrl };
  }
}

async function fetchAmazonMeta(amazonUrl) {
  const { asin: asinFromRedirect, finalUrl: redirectUrl } = await followRedirectForAsin(amazonUrl);
  try {
    const res = await fetch(amazonUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      if (!asinFromRedirect) return null;
      // FIX: Return null for image when scrape fails — never use /images/P/ format
      return {
        title: null, price: null,
        image: null,
        asin: asinFromRedirect, finalUrl: redirectUrl,
      };
    }
    const finalUrl = res.url;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || asinFromRedirect || null;
    const html = await res.text();
    const title =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    // FIX: og:image returns the correct /images/I/ format — no /images/P/ fallback
    const image =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || null;
    const priceMatch =
      html.match(/["']priceAmount["']\s*:\s*["']?([\d.]+)["']?/)
      || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;
    return {
      title: title?.replace(/\s*[|:]\s*amazon\b.*/i, '')
        .replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '')
        .trim().substring(0, 150) || null,
      image, price, asin, finalUrl,
    };
  } catch (e) {
    if (!asinFromRedirect) return null;
    // FIX: Return null for image on error — never use /images/P/ format
    return {
      title: null, price: null,
      image: null,
      asin: asinFromRedirect, finalUrl: redirectUrl,
    };
  }
}

// ─── Text helpers ──────────────────────────────────────────────────────────

function maybeUrlDecode(text) {
  if (!text) return '';
  const enc = text.match(/%[0-9A-Fa-f]{2}/g) || [];
  if (enc.length < 3) return text;
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch (e) {
    return text;
  }
}

function stripHtmlKeepLines(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isGarbageText(s) {
  if (!s) return true;
  let decoded = s;
  try { decoded = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) {}
  const encodedMatches = s.match(/%[0-9A-Fa-f]{2}/g) || [];
  if (encodedMatches.length > 2) return true;
  const plusMatches = s.match(/\+/g) || [];
  if (plusMatches.length > 3) return true;
  if (/googleusercontent|googleapis|gstatic|promocode/i.test(decoded)) return true;
  if (/dummy_textarea|position.*absolute|overflow.*hidden|opacity.*0|emailBody=|<!DOCTYPE|<html|ExternalClass|MsoNormal|font-size|margin:|padding:|border:/i.test(decoded)) return true;
  if (/here\s+is\s+a\s+list|for\s+your\s+reference|original\s+price\s*:/i.test(decoded)) return true;
  // FIX: Reject common email boilerplate phrases that are NOT product titles
  if (/save\s+\d+\s*%\s+on\s+(?:the\s+)?eligible/i.test(decoded)) return true;
  if (/terms\s+and\s+conditions|must\s+sign\s+in|redeem\s+this\s+promotion|unsubscribe|privacy\s+policy|view\s+in\s+browser|click\s+here\s+to/i.test(decoded)) return true;
  if (/you\s+must\s+|please\s+note\s+|this\s+email\s+|dear\s+customer|dear\s+friend/i.test(decoded)) return true;
  const letters = (decoded.match(/[a-zA-Z\s]/g) || []).length;
  if (decoded.length > 0 && letters / decoded.length < 0.6) return true;
  if (decoded.trim().length < 8) return true;
  return false;
}

function parseDateString(raw, defaultHour = '00', defaultMin = '00') {
  if (!raw) return null;
  let s = raw
    .replace(/\s*(?:PDT|PST|PST8PDT|EDT|EST|UTC|GMT)[^\s]*/gi, '')
    .replace('T', ' ')
    .trim();
  const concat = s.match(/^(\d{4})-(\d{1,2})-(\d{2})(\d{2}:\d{2})?$/);
  if (concat) {
    const [, yr, mo, dy, tm] = concat;
    const [hr, mn] = tm ? tm.split(':') : [defaultHour, defaultMin];
    const d = new Date(`${yr}-${mo.padStart(2,'0')}-${dy}T${hr.padStart(2,'0')}:${mn.padStart(2,'0')}:00Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  const standard = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (standard) {
    const [, yr, mo, dy, hr = defaultHour, mn = defaultMin] = standard;
    const d = new Date(
      `${yr}-${mo.padStart(2,'0')}-${dy.padStart(2,'0')}` +
      `T${String(hr).padStart(2,'0')}:${String(mn).padStart(2,'0')}:00Z`
    );
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function parsePriceValue(str) {
  if (!str) return null;
  const s = str.trim().replace(/^\$/, '');
  const rangeMatch = s.match(/^([\d]+(?:\.[\d]+)?)\s*[-–]\s*([\d]+(?:\.[\d]+)?)$/);
  if (rangeMatch) {
    return { low: parseFloat(rangeMatch[1]), high: parseFloat(rangeMatch[2]), raw: s, isRange: true };
  }
  const single = parseFloat(s);
  if (isNaN(single)) return null;
  return { low: single, high: single, raw: s, isRange: false };
}

function formatPrice(p) {
  if (!p) return null;
  return p.isRange ? `$${p.raw}` : `$${p.low.toFixed(2)}`;
}

// ─── Per-product block field extractor ────────────────────────────────────

function extractFieldsFromBlock(block, prevTail) {
  const dpMatch =
    block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>\n]*/i)
    || block.match(/https?:\/\/amzn\.to\/[A-Za-z0-9]+/i)
    || block.match(/https?:\/\/a\.co\/[A-Za-z0-9/]+/i);
  const realUrl = dpMatch ? dpMatch[0].replace(/["'\s]+$/, '') : null;
  const asinFromUrl = realUrl
    ? (realUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null)
    : null;
  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/promocode\/[A-Z0-9]+/i);
  const promocodeUrl = promoMatch ? promoMatch[0].replace(/\s+/g, '') : null;

  const codeMatch = block.match(
    /(?:discount\s*code|promo(?:tion)?\s*code|coupon\s*code|(?<![a-zA-Z])code|(?<![a-zA-Z])coupon)\s*[:：]\s*["']?([A-Z0-9]{4,20})\b/i
  );
  const promoCode = codeMatch ? codeMatch[1].toUpperCase() : null;

  const couponPctMatch = block.match(/(?<![a-zA-Z])coupon\s*[:：]\s*(\d{1,3})\s*%/i);
  const couponPct = couponPctMatch
    ? (promoCode && couponPctMatch[0].includes(promoCode) ? null : couponPctMatch[1])
    : null;

  const PRICE_PATTERN = /\$?\s*([\d]+(?:\.[\d]+)?(?:\s*[-–]\s*[\d]+(?:\.[\d]+)?)?)/;
  const saleLabelRe = new RegExp(
    '(?:deal\\s*price|discount\\s*price|product\\s*price|sale\\s*price' +
    '|after\\s*(?:the\\s*)?discount\\s*price|price\\s*after\\s*discount|final\\s*price)' +
    '\\s*[:：]?\\s*' + PRICE_PATTERN.source, 'i'
  );
  const barePriceRe = new RegExp('(?:^|\\n)[ \\t]*price\\s*[:：]\\s*' + PRICE_PATTERN.source, 'i');
  const salePriceRaw = (block.match(saleLabelRe) || block.match(barePriceRe))?.[1] || null;
  let salePrice = parsePriceValue(salePriceRaw);

  const origLabelRe = new RegExp(
    '(?:original\\s*price|price\\s*before\\s*discount|list\\s*price|was' +
    '|reg(?:ular)?\\.?\\s*(?:price)?)\\s*[:：]?\\s*' + PRICE_PATTERN.source, 'i'
  );
  const origPriceRaw = block.match(origLabelRe)?.[1] || null;
  let origPrice = parsePriceValue(origPriceRaw);

  if (salePrice && origPrice && !salePrice.isRange && !origPrice.isRange && origPrice.low < salePrice.low) {
    [salePrice, origPrice] = [origPrice, salePrice];
  }
  if (!salePrice && !origPrice) {
    const amounts = [...block.matchAll(/\$\s*([\d]+\.[\d]{1,2})\b/g)]
      .map(m => parseFloat(m[1])).filter(p => p > 0);
    if (amounts.length >= 2) {
      const sorted = [...amounts].sort((a, b) => a - b);
      salePrice = parsePriceValue(String(sorted[0]));
      origPrice = parsePriceValue(String(sorted[sorted.length - 1]));
    }
  }

  let discount = null;
  if (prevTail) {
    const ptm = prevTail.match(/(?:discount|%off)\s*[:：]?\s*(\d{1,2})\s*%/i);
    if (ptm) discount = ptm[1];
  }
  if (!discount) {
    const dm =
      block.match(/(?:^|[\n\s])(?:discount|%off)\s*[:：]\s*(\d{1,2})\s*%/i)
      || block.match(/(\d{1,2})\s*%\s*(?:off(?:\s+prime)?|OFF(?:\s+PRIME)?)\b/i)
      || block.match(/(\d{1,2})\s*%\s*(?:discount)\b/i)
      || block.match(/[Ss]ave\s+(\d{1,2})\s*%/i);
    if (dm) discount = dm[1];
  }
  if (!discount && salePrice && origPrice && !salePrice.isRange && !origPrice.isRange && origPrice.low > 0) {
    const pct = Math.round((1 - salePrice.low / origPrice.low) * 100);
    if (pct >= 5 && pct <= 95) discount = String(pct);
  }

  const startRaw = block.match(/start\s*(?:date|day|time)?\s*[:：]?\s*([\d]{4}-[\d]{1,2}-[\d]{1,2}(?:\s*T?\s*[\d]{1,2}:[\d]{2})?)/i);
  const startDate = startRaw ? parseDateString(startRaw[1], '00', '00') : null;
  const endRaw = block.match(/end\s*(?:date|day|time)?\s*[:：]?\s*([\d]{4}-[\d]{1,2}-[\d]{1,2}(?:\s*T?\s*[\d]{1,2}:[\d]{2})?)/i);
  const endDateParsed = endRaw ? parseDateString(endRaw[1], '23', '59') : null;
  const endDate = (endDateParsed && new Date(endDateParsed).getTime() > Date.now()) ? endDateParsed : null;

  return { asinFromUrl, realUrl, promocodeUrl, promoCode, couponPct, discount,
    salePrice: formatPrice(salePrice), originalPrice: formatPrice(origPrice), startDate, endDate };
}

// ─── Title extraction ──────────────────────────────────────────────────────

const FIELD_LINE_RE = /^(?:original\s*price|price\s*before|deal\s*price|discount\s*price|product\s*price|sale\s*price|after\s*the\s*discount|final\s*price|code\s*[:：]|coupon\s*[:：]|promo|link\s*[:：]|start\s*(?:date|day|time)|end\s*(?:date|day|time)|%off|discount\s*[:：]|\d+\s*%|https?:\/\/|us\d+\s+creator|creator\s+campaign|campaign\s*id|dear\s+friend|today\s+we)/i;

function extractTitleFromBlock(blockText, strategy) {
  const lines = blockText.split('\n').map(l => l.trim()).filter(Boolean);
  if (strategy === 'label') {
    const firstLine = lines[0] || '';
    const inlineFieldMatch = firstLine.match(
      /\b(?:original\s*price|price\s*before|deal\s*price|discount\s*price|product\s*price|sale\s*price|after\s*(?:the\s*)?discount|code\s*[:：]|coupon\s*[:：]|link\s*[:：]|start\s*date|end\s*(?:date|day)|%off\s*[:：]|\d+\s*%\s*off)/i
    );
    const raw = inlineFieldMatch ? firstLine.slice(0, inlineFieldMatch.index) : firstLine;
    const title = raw.replace(/^["""'\s]+|["""'",:：\s]+$/g, '').substring(0, 200);
    if (title.length > 4 && !isGarbageText(title)) return title;
  }
  if (strategy === 'numbered') {
    for (const line of lines.slice(1, 4)) {
      const m = line.match(/^["""']?(?:products?\s*(?:name|title)|title)\s*[:：]\s*(.+)/i);
      if (m) {
        const title = m[1].replace(/^["""'\s]+|["""'",:：\s]+$/g, '').substring(0, 200);
        if (!isGarbageText(title)) return title;
      }
    }
    for (const line of lines.slice(1)) {
      if (!FIELD_LINE_RE.test(line) && !/^https?:\/\//i.test(line) && line.length > 10 && !isGarbageText(line)) {
        return line.replace(/^["""'\s]+|["""'",:：\s]+$/g, '').substring(0, 200);
      }
    }
  }
  for (const line of lines) {
    const m = line.match(/^["""']?(?:products?\s*(?:name|title)|title)\s*[:：]\s*(.+)/i);
    if (m) {
      const title = m[1].replace(/^["""'\s]+|["""'",:：\s]+$/g, '').substring(0, 200);
      if (!isGarbageText(title)) return title;
    }
  }
  // FIX: In 'fallback' strategy, only return a title if there's also a real Amazon URL
  if (strategy === 'fallback') {
    const hasAmazonUrl = /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(blockText);
    if (!hasAmazonUrl) return null;
  }
  for (const line of lines) {
    if (!FIELD_LINE_RE.test(line) && !/^https?:\/\//i.test(line) && line.length > 10 && !isGarbageText(line)) {
      return line.replace(/^["""'\s]+|["""'",:：\s]+$/g, '').substring(0, 200);
    }
  }
  return null;
}

// ─── Block splitting ───────────────────────────────────────────────────────

function splitAtPositions(text, positions) {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  return sorted.map((start, i) => ({
    blockText: text.slice(start, sorted[i + 1] ?? text.length).trim(),
    prevTail: text.slice(0, start).slice(-200),
  }));
}

function parseEmailIntoProductBlocks(text) {
  const results = [];

  function addBlock(blockText, prevTail, strategy) {
    if (blockText.length < 5) return;
    const title = extractTitleFromBlock(blockText, strategy);
    const fields = extractFieldsFromBlock(blockText, prevTail);
    if (!title && !fields.realUrl && !fields.promocodeUrl) return;
    results.push({ title, ...fields });
  }

  // ── Strategy 0: Amazon "Save X% on eligible items" multi-product format ──
  const eligibleMatch = text.match(/[Ss]ave\s+(\d{1,2})\s*%\s+on\s+(?:the\s+)?eligible/i);
  if (eligibleMatch) {
    const globalDiscount = eligibleMatch[1];
    const globalCodeMatch = text.match(
      /(?:discount\s*code|promo(?:tion)?\s*code|coupon\s*code|(?<![a-zA-Z])code)\s*[:：]\s*["']?([A-Z0-9]{4,20})\b/i
    );
    const globalCode = globalCodeMatch ? globalCodeMatch[1].toUpperCase() : null;
    const allUrlMatches = [
      ...text.matchAll(/https?:\/\/(?:www\.)?amazon\.com\/(?:[^\s"'<>\n]*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>\n]*/gi)
    ];
    const seenAsins0 = new Set();
    for (const m of allUrlMatches) {
      const asinFromUrl = m[1].toUpperCase();
      if (seenAsins0.has(asinFromUrl)) continue;
      seenAsins0.add(asinFromUrl);
      const realUrl = m[0].replace(/["'\s]+$/, '');
      results.push({ title: null, asinFromUrl, realUrl, promocodeUrl: null,
        promoCode: globalCode, couponPct: null, discount: globalDiscount,
        salePrice: null, originalPrice: null, startDate: null, endDate: null });
    }
    if (results.length > 0) {
      console.log(`[Strategy 0] "Save ${globalDiscount}% eligible items" — ${results.length} product URL(s) found`);
      return results.slice(0, 20);
    }
    console.log(`[Strategy 0] "Save ${globalDiscount}% eligible items" email but no /dp/ URLs found — skipping`);
    return results;
  }

  // ── Strategy 1: Split on title label markers ───────────────────────────────
  const TITLE_LABEL_RE = /(?:products?\s*(?:name|title)|(?<![a-zA-Z])title)\s*[:：]/gi;
  const titleMatches = [...text.matchAll(TITLE_LABEL_RE)];
  if (titleMatches.length > 0) {
    const segs = splitAtPositions(text, titleMatches.map(m => m.index + m[0].length));
    for (const { blockText, prevTail } of segs) addBlock(blockText, prevTail, 'label');
    if (results.length > 0) return results.slice(0, 20);
  }

  // ── Strategy 2: Split on numbered list prefixes at line start ──────────────
  const NUMBERED_RE = /(?:^|\n)[ \t]*\d+\s*[.、]/gm;
  const numMatches = [...text.matchAll(NUMBERED_RE)];
  if (numMatches.length > 0) {
    const positions = numMatches.map(m => m.index + (text[m.index] === '\n' ? 1 : 0));
    const segs = splitAtPositions(text, positions);
    for (const { blockText, prevTail } of segs) addBlock(blockText, prevTail, 'numbered');
    if (results.length > 0) return results.slice(0, 20);
  }

  // ── Strategy 3: Split on double blank lines (Amazon URL required) ──────────
  const blankParts = text.split(/\n{2,}/);
  if (blankParts.length > 1) {
    let offset = 0;
    for (const part of blankParts) {
      const trimmed = part.trim();
      const prevTail = text.slice(0, offset).slice(-200);
      if (trimmed.length >= 10 && /https?:\/\/(?:www\.)?amazon\.com\/(?:[^\s"'<>\n]*\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(trimmed)) {
        addBlock(trimmed, prevTail, 'fallback');
      }
      offset += part.length + 2;
    }
    if (results.length > 0) return results.slice(0, 20);
  }

  // Strategy 4 removed — caused boilerplate to be saved as product titles.
  return results;
}

// ─── Main handler ──────────────────────────────────────────────────────────

export default async (req, context) => {
  const urlObj = new URL(req.url);
  const debugMode = urlObj.searchParams.get('debug') === 'true';
  let emailBody = '', title = '', snippet = '';
  if (req.method === 'GET') {
    emailBody = urlObj.searchParams.get('emailBody') || '';
    title = urlObj.searchParams.get('title') || '';
    snippet = urlObj.searchParams.get('snippet') || '';
  } else if (req.method === 'POST') {
    try { emailBody = await req.text(); } catch (e) { emailBody = ''; }
  }

  let content = (emailBody || title).trim();
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.emailBody) content = String(parsed.emailBody);
      else if (parsed.snippet) content = String(parsed.snippet);
    }
  } catch (e) {}

  content = maybeUrlDecode(content);
  const lineText = stripHtmlKeepLines(content);
  const blocks = parseEmailIntoProductBlocks(lineText);
  console.log(`[Parser] ${blocks.length} product block(s) from email (debug=${debugMode})`);

  if (debugMode) {
    const preview = blocks.map(block => ({
      title: block.title || null,
      asin: block.asinFromUrl || null,
      originalPrice: block.originalPrice || null,
      salePrice: block.salePrice || null,
      discount: block.discount ? `${block.discount}%` : null,
      promoCode: block.promoCode || null,
      couponPct: block.couponPct ? `${block.couponPct}%` : null,
      amazonUrl: block.realUrl || block.promocodeUrl || null,
      imageUrl: null,
      startDate: block.startDate || null,
      endDate: block.endDate || null,
      flags: { asinMissing: !block.asinFromUrl && !!block.promocodeUrl, hasPromocode: !!block.promocodeUrl },
    }));
    return new Response(JSON.stringify({ debug: true, count: blocks.length, deals: preview }, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const store = getStore("submissions");
  const queueStore = getStore("deal-queue");
  const savedIds = [], deals = [], queueItems = [];
  const seenAsins = new Set();

  for (const block of blocks) {
    let affiliateUrl = '', imageUrl = null, dealTitle = block.title, asin = null;
    let status = 'pending', priceFromMeta = null;

    if (block.realUrl) {
      console.log(`[Block] real URL: ${block.realUrl}`);
      const meta = await fetchAmazonMeta(block.realUrl);
      asin = block.asinFromUrl || meta?.asin || null;
      affiliateUrl = asin
        ? `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`
        : (block.realUrl.includes('tag=') ? block.realUrl : `${block.realUrl}${block.realUrl.includes('?') ? '&' : '?'}tag=${PARTNER_TAG}`);
      imageUrl = meta?.image || null;
      dealTitle = (meta?.title && !isGarbageText(meta.title) ? meta.title : null) || block.title || null;
      priceFromMeta = meta?.price || null;
      if (asin && affiliateUrl && imageUrl && dealTitle && !isGarbageText(dealTitle)) status = 'approved';
    } else if (block.promocodeUrl) {
      console.log(`[Block] promocode URL (no ASIN) — will be rejected by validation: ${block.promocodeUrl}`);
    } else if (block.title) {
      console.log(`[Block] no URL — searching Amazon by title: "${block.title}"`);
      const searchResult = await searchAmazonByTitle(block.title);
      if (searchResult) {
        asin = searchResult.asin;
        affiliateUrl = searchResult.url;
        imageUrl = searchResult.image;
        dealTitle = block.title;
        if (asin && affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
      }
    }

    if (asin && seenAsins.has(asin)) { console.log(`[SKIP] Duplicate ASIN ${asin}`); continue; }
    if (asin) seenAsins.add(asin);

    // ── STRICT VALIDATION: all 5 required fields must be present ──────────────
    const hasPriceOrDiscount = !!(block.salePrice || block.discount || priceFromMeta);
    const hasValidTitle = !!(dealTitle && !isGarbageText(dealTitle));
    // Image is NOT required at submit time — post-queued-deal.mjs re-fetches it with more
    // robust scraping. Requiring it here blocks valid deals when Amazon 403s the scraper.
    if (!asin || !hasValidTitle || !affiliateUrl || !hasPriceOrDiscount) {
      console.log(`[SKIP] Missing required field(s) — asin=${!!asin} title=${hasValidTitle} url=${!!affiliateUrl} img=${!!imageUrl} price=${hasPriceOrDiscount} — "${String(dealTitle ?? '').substring(0, 60)}"`);
      continue;
    }

    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id, title: dealTitle,
      price: block.salePrice || priceFromMeta || null,
      originalPrice: block.originalPrice || null,
      discount: block.discount || null,
      url: affiliateUrl, imageUrl,
      discountCode: block.promoCode || null,
      couponPct: block.couponPct || null,
      source: "email", status, asinMissing: false, sponsored: false,
      createdAt: new Date().toISOString(),
      startDate: block.startDate || null,
      expiresOn: block.endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.setJSON(id, submission);
    savedIds.push(id);
    deals.push({ id, title: dealTitle, price: block.salePrice || priceFromMeta || null, url: affiliateUrl, imageUrl });

    if (status === 'approved') {
      queueItems.push({ id, title: dealTitle,
        price: block.salePrice || priceFromMeta || null,
        originalPrice: block.originalPrice || null,
        discount: block.discount || null,
        url: affiliateUrl, imageUrl,
        promoCode: block.promoCode || null, asin, store: 'amazon' });
    }

    let index = [];
    try { index = await store.get("index", { type: "json" }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);
    await new Promise(r => setTimeout(r, 10));
  }

  if (queueItems.length > 0) {
    try {
      let queue = [];
      try { queue = await queueStore.get('queue', { type: 'json' }) || []; } catch (e) { queue = []; }
      queue.push(...queueItems);
      await queueStore.setJSON('queue', queue);
    } catch (e) { console.error('Queue write failed:', e.message); }
  }

  const telegramMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 <b>New Deal Alert!</b>\n\n🛍️ <b>${deals[0].title}</b>\n\n💰 <b>${deals[0].price || 'Check link'}</b>\n\n🔗 <a href="${deals[0].url}">👉 Grab this deal!</a>`
      : `🔥 <b>${deals.length} New Deals Alert!</b>\n\n` + deals.map((d, i) =>
        `${i + 1}. 🛍️ <b>${d.title}</b>\n   💰 <b>${d.price || 'Check link'}</b>\n   🔗 <a href="${d.url}">Grab deal</a>`
      ).join('\n\n');

  const facebookMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 New Deal Alert!\n\n🛍️ ${deals[0].title}\n\n💰 ${deals[0].price || 'Check link'}\n\n🔗 ${deals[0].url}\n\n#ad #deals #amazon #dealsaholic #shopping #sale`
      : `🔥 ${deals.length} New Deals Alert!\n\n` + deals.map((d, i) =>
        `${i + 1}. 🛍️ ${d.title}\n   💰 ${d.price || 'Check link'}\n   🔗 ${d.url}`
      ).join('\n\n') + '\n\n#ad #deals #amazon #dealsaholic #shopping #sale';

  return new Response(JSON.stringify({
    success: true, count: deals.length, ids: savedIds, deals,
    productBlocksFound: blocks.length, telegramMessage, facebookMessage,
    title: deals[0]?.title || null, price: deals[0]?.price || null,
    url: deals[0]?.url || null, imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/submit-email-deal" };
