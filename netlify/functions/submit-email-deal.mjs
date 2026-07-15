import { getStore } from "@netlify/blobs";

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const AFFILIATE_TAG = 'daholic-20';
const AMAZON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml',
};

// ── AFFILIATE LINK — every Amazon URL MUST pass through this ─────────────────
function appendAffiliateTag(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.set('tag', AFFILIATE_TAG);
    return u.toString();
  } catch {
    const sep = url.includes('?') ? '&' : '?';
    return url + sep + 'tag=' + AFFILIATE_TAG;
  }
}

function normalizeAmazonUrl(rawUrl, asin) {
  if (asin) return appendAffiliateTag(`https://www.amazon.com/dp/${asin}`);
  return appendAffiliateTag(rawUrl);
}

// ── NORMALIZE URL for dedup (strip query params, lowercase) ─────────────────
function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return url.toLowerCase().trim();
  }
}

// ── FOLLOW REDIRECT to resolve ASIN ─────────────────────────────────────────
async function followRedirectForAsin(amazonUrl) {
  try {
    const res = await fetch(amazonUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': AMAZON_HEADERS['User-Agent'] },
    });
    const finalUrl = res.url || amazonUrl;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    return { asin, finalUrl };
  } catch {
    return { asin: null, finalUrl: amazonUrl };
  }
}

// ── IMAGE EXTRACTION — multiple strategies ───────────────────────────────────

function extractOgImage(html) {
  return html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1]
    || html.match(/<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)?.[1]
    || null;
}

function extractImagesFromEmailHtml(rawHtml) {
  const seen = new Set();
  const images = [];

  const add = (url) => {
    if (url && !seen.has(url)) { seen.add(url); images.push(url); }
  };

  for (const m of rawHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (src && (
      src.includes('m.media-amazon.com') ||
      src.includes('images-na.ssl-images-amazon.com') ||
      src.includes('images-amazon.com') ||
      src.includes('ssl-images-amazon.com')
    )) add(src);
  }

  for (const m of rawHtml.matchAll(/https?:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-amazon\.com|ssl-images-amazon\.com)\/images\/[^\s"'<>]+/gi)) {
    add(m[0]);
  }

  return images.filter(u =>
    !u.includes('._SL75_') && !u.includes('._SS40_') && !u.includes('_SX38_') &&
    !u.includes('._SL30_') && !u.includes('1x1') && !u.includes('pixel')
  );
}

async function fetchProductPageImage(asin) {
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, { headers: AMAZON_HEADERS, redirect: 'follow' });
    if (!res.ok) return null;
    const html = await res.text();
    // Try hiRes JSON first (most reliable), then og:image
    const hiRes = html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1];
    return hiRes || extractOgImage(html);
  } catch { return null; }
}

// ── FETCH AMAZON PAGE METADATA ────────────────────────────────────────────────
async function fetchAmazonMeta(amazonUrl) {
  const { asin: asinFromRedirect, finalUrl: redirectUrl } = await followRedirectForAsin(amazonUrl);
  try {
    const res = await fetch(amazonUrl, { headers: AMAZON_HEADERS, redirect: 'follow' });
    if (!res.ok) {
      return asinFromRedirect
        ? { title: null, price: null, image: null, asin: asinFromRedirect, finalUrl: redirectUrl }
        : null;
    }

    const finalUrl = res.url;
    let asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || asinFromRedirect || null;
    const html = await res.text();

    let title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;

    let image = html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || extractOgImage(html);

    if (!asin || !image) {
      const bodyAsin = html.match(/\/dp\/([A-Z0-9]{10})[/"'?\s]/i)?.[1];
      if (bodyAsin && !asin) asin = bodyAsin;
      if (asin && !image) image = await fetchProductPageImage(asin);
    }

    if (!image) {
      const pageImages = extractImagesFromEmailHtml(html);
      if (pageImages.length > 0) image = pageImages[0];
    }

    // Amazon ad widget fallback — works even when scraping is blocked
    if (!image && asin) {
      const widgetUrl = `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL300_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822&WS=1`;
      try {
        const wRes = await fetch(widgetUrl, { redirect: 'follow' });
        const ct = wRes.headers.get('content-type') || '';
        if (wRes.ok && ct.startsWith('image/')) image = wRes.url;
      } catch {}
    }

    const priceMatch = html.match(/["']priceAmount["']\s*:\s*["']?([\d.]+)["']?/)
      || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;

    return {
      title: title?.replace(/\s*[|:]\s*amazon\b.*/i, '').replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '').trim().substring(0, 150) || null,
      image, price, asin, finalUrl,
    };
  } catch {
    return asinFromRedirect
      ? { title: null, price: null, image: null, asin: asinFromRedirect, finalUrl: redirectUrl }
      : null;
  }
}

// ── EXTRACT ALL AMAZON URLs ───────────────────────────────────────────────────
function extractAmazonUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    /https?:\/\/(?www\.)?amazon\.com\/(?:promocode|promotion|gp\/promocode|deal|gp\/goldbox|gp\/subscribe-and-save|savings|coupons|gp\/deal)[^\s"'<>]*/gi,
    /https?:\/\/(?:www\.)?amazon\.com\/[a-zA-Z0-9\-_\/+%?=&#@!.]{5,}[^\s"'<>]*/gi,
    /https?:\/\/(?:amzn\.to|a\.co)\/[A-Za-z0-9\/]+/gi,
  ];
  const seen = new Set();
  const urls = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const url = m[0].replace(/[.,;)\]]*$/, '');
      if (!seen.has(url)) { seen.add(url); urls.push(url); }
    }
  }
  return urls;
}

// ── STRIP HTML TAGS ─────────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

// ── CLEAN EMAIL CONTENT ───────────────────────────────────────────────────────
function cleanEmailContent(text) {
  const markers = [
    /&emailText=/i,
    /This is an automated message/i,
    /Your deals could NOT be processed/i,
    /Reason\s*:\s*Duplicate/i,
  ];
  let cleaned = text;
  for (const marker of markers) {
    const idx = cleaned.search(marker);
    if (idx !== -1) cleaned = cleaned.slice(0, idx);
  }
  return cleaned.trim();
}

// ── STRATEGY 1: Split numbered product blocks ─────────────────────────────────
function splitProductBlocks(text) {
  const patterns = [
    /(?:^|\n)\s*\d+\s+Product\s*[Nn]ame/g,
    /(?:^|\n)\s*\d+[.)]\s*(?:\n|$)/g,
  ];
  for (const regex of patterns) {
    const matches = [...text.matchAll(regex)];
    if (matches.length > 1) {
      const blocks = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = matches[i + 1]?.index ?? text.length;
        blocks.push(text.slice(start, end).trim());
      }
      return blocks.filter(b => b.length > 10);
    }
  }
  return [text];
}

// ── STRATEGY 1: Extract fields from a structured product block ────────────────
function extractProductData(block) {
  const titleMatch = block.match(/Product\s*[Nn]ame\s*[:\s]+([^\n]+)/i);
  let title = titleMatch?.[1]?.trim().substring(0, 150) || null;
  if (title) title = title
    .replace(/amazon\.com\s*/gi, '').replace(/\s*[|:]\s*amazon\b.*/i, '')
    .replace(/^\d+%\s*off\s+/i, '')
    .replace(/^hotsales\s+/i, '')
    .replace(/\s*[—–]\sonly\s+\$[\d.]+[^-]!?\s*$/i, '')
    .trim();

  const priceMatch = block.match(/(?:Deal\s*Price|Final\s*Price|Sale\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;

  const origMatch = block.match(/(?:Original\s*Price|Reg\.?\s*Price|Was|Regular\s*Price|List\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const originalPrice = origMatch ? '$' + origMatch[1].replace(/,/g, '') : null;

  const discountMatch = block.match(/(\d+*%\s*(?:off|discount|save)/i);
  const discount = discountMatch?.[1] || null;

  const codeMatch = block.match(/(?:^|\n)\s*(?:code|coupon|promo)\s*[:\s]+([A-Z0-9]{4,20})/im)
    || block.match(/\bwith\s+code\s*[:\s]+([A-Z0-9]{4,20})/i)
    || block.match(/\bcode\s*[:\s]+([A-Z0-9]{4,20})\b/i);
  const discountCode = codeMatch?.[1]?.trim() || null;

  const dpMatch    = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>]*/i);
  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:promocode|promotion|gp\/promocode|deal|gp\/goldbox|gp\/subscribe-and-save|savings|coupons|gp\/deal)[^\s"'<>]*/i);
  const shortMatch = block.match(/https?:\/\/(?:amzn\.to|a\.co)\/[A-Za-z0-9\/]+/i);
  const anyAmazon  = block.match(/https?:\/\/(?:www\.)?amazon\.com\/[a-zA-Z0-9\-_\/+%?=&#@!.]{5,}[^\s"'<>]*/i);

  const asin   = dpMatch?.[1] || null;
  const rawUrl = dpMatch?.[0] || promoMatch?.[0] || shortMatch?.[0] || anyAmazon?.[0] || null;

  const expMatch = block.match(/(?:End\s*Date|Expir(?:es?|ation)\s*(?:Date)?)\s*[:\s]+([^\n]+)/i);
  let expiresOn = null;
  if (expMatch?.[1]) {
    try {
      const d = new Date(expMatch[1].trim());
      if (!isNaN(d.getTime())) expiresOn = d.toISOString();
    } catch {}
  }

  return { title, price, originalPrice, discount, discountCode, rawUrl, asin, expiresOn };
}

// ── STRATEGY 4: Extract title from plain-text email ───────────────────────────
function extractFallbackTitle(text) {
  const saveMatch = text.match(/save\s+\d+%\s+(?:on\s+)?(.{10,150}?)(?:\n|$)/i);
  if (saveMatch) return saveMatch[1].trim().substring(0, 150);
  const offMatch = text.match(/\d+%\s+off\s+(?:on\s+)?(.{10,150}?)(?:\n|$)/i);
  if (offMatch) return offMatch[1].trim().substring(0, 150);
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('http') && l.length > 8);
  return lines[0]?.substring(0, 150) || null;
}

// ── SAVE ONE DEAL to Netlify Blobs ───────────────────────────────────────────
// BUG FIX: status was 'pending' — both post-to-facebook.mjs and
// post-deals-to-telegram.mjs skip deals where status !== 'approved'.
// Email deals were permanently stuck and never posted.
async function saveDeal(store, fields) {
  const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const submission = {
    id,
    title:         fields.title,
    price:         fields.price         || null,
    originalPrice: fields.originalPrice || null,
    discount:      fields.discount      || null,
    url:           fields.affiliateUrl,
    imageUrl:      fields.imageUrl      || null,
    discountCode:  fields.discountCode  || null,
    source:        'email',
    status:        'approved',          // FIX: was 'pending' — schedulers require 'approved'
    sponsored:     false,
    facebookPosted:  false,             // FIX: explicit flag for post-to-facebook.mjs
    telegramPosted:  false,             // FIX: explicit flag for post-deals-to-telegram.mjs
    createdAt:     new Date().toISOString(),
    expiresOn:     fields.expiresOn || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  await store.setJSON(id, submission);
  let index = [];
  try { index = await store.get('index', { type: 'json' }) || []; } catch { index = []; }
  index.unshift(id);
  await store.setJSON('index', index);
  await new Promise(r => setTimeout(r, 10));
  return { id, title: submission.title, price: submission.price, url: submission.url, imageUrl: submission.imageUrl };
}

// ── MAIN HANDLER ─────────────────────────────────────────────────────────────
export default async (req, context) => {
  const urlObj = new URL(req.url);
  let emailBody = '', emailTitle = '';

  if (req.method === 'GET') {
    emailBody  = urlObj.searchParams.get('emailBody') || '';
    emailTitle = urlObj.searchParams.get('title')     || '';
  } else if (req.method === 'POST') {
    try { emailBody = await req.text(); } catch { emailBody = ''; }
  }

  const rawHtml = (emailBody || emailTitle).trim();

  console.log(`[EMAIL-PARSER] ━━━ Email received ━━━`);
  console.log(`[EMAIL-PARSER] Method: ${req.method} | Subject: "${emailTitle}" | Body length: ${rawHtml.length} chars`);

  // ── STRATEGY 3: Extract Amazon CDN images from raw email HTML BEFORE stripping
  const emailImages = extractImagesFromEmailHtml(rawHtml);
  console.log(`[EMAIL-PARSER] CDN images found in email HTML: ${emailImages.length}`);
  if (emailImages.length > 0) console.log(`[EMAIL-PARSER] First CDN image: ${emailImages[0]}`);

  const cleanedText = cleanEmailContent(stripHtml(rawHtml));
  console.log(`[EMAIL-PARSER] Cleaned text length: ${cleanedText.length} chars`);
  console.log(`[EMAIL-PARSER] Cleaned text preview: "${cleanedText.substring(0, 200).replace(/\n/g, ' ')}"`);

  const store = getStore('submissions');

  // ── DEDUP: load indexes once upfront ─────────────────────────────────────────
  // BUG FIX: No dedup existed before — same email processed twice created
  // duplicate DB entries, both of which got posted to Facebook/Telegram.
  let asinIndex = {}, urlIndex = {};
  try { asinIndex = await store.get('asin-index', { type: 'json' }) || {}; } catch {}
  try { urlIndex  = await store.get('url-index',  { type: 'json' }) || {}; } catch {}
  console.log(`[EMAIL-PARSER] Dedup index loaded: ${Object.keys(asinIndex).length} ASINs, ${Object.keys(urlIndex).length} URLs`);

  const savedIds = [];
  const deals    = [];

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 1: Structured numbered product blocks ("1 Product name:" or "1.")
  // ════════════════════════════════════════════════════════════════════════════
  const blocks = splitProductBlocks(cleanedText);
  console.log(`[EMAIL-PARSER] Strategy 1: ${blocks.length} block(s) detected`);

  for (const block of blocks) {
    const {
      title: blockTitle, price, originalPrice, discount,
      discountCode, rawUrl: structuredUrl, asin: blockAsin, expiresOn,
    } = extractProductData(block);

    // Strategy 2 (block-level): if structured parse found no URL, scan for any Amazon URL
    let resolvedUrl = structuredUrl;
    if (!resolvedUrl) {
      const fallbackUrls = extractAmazonUrls(block);
      resolvedUrl = fallbackUrls[0] || null;
      if (resolvedUrl) console.log(`[EMAIL-PARSER] Strategy 2 (block-level) URL: ${resolvedUrl}`);
    }

    if (!resolvedUrl) {
      console.log(`[EMAIL-PARSER] SKIP block — no Amazon URL found. Preview: "${block.substring(0, 80).replace(/\n/g, ' ')}"`);
      continue;
    }

    let asin = blockAsin;
    if (!asin) {
      const r = await followRedirectForAsin(resolvedUrl);
      asin = r.asin || null;
    }
    console.log(`[EMAIL-PARSER] ASIN resolved: ${asin || 'none'} (tracking ID will be: ${asin ? 'tag='+AFFILIATE_TAG+' via /dp/ASIN' : 'tag='+AFFILIATE_TAG+' appended to raw URL'})`);

    // ── DEDUP CHECK (block) ──────────────────────────────────────────────────
    const affiliateUrlForDedup = normalizeAmazonUrl(resolvedUrl, asin);
    const normUrlForDedup = normalizeUrl(affiliateUrlForDedup);
    if (asin && asinIndex[asin]) {
      console.log(`[EMAIL-PARSER] DUPLICATE — ASIN ${asin} already in DB as ${asinIndex[asin]}. Skipping block.`);
      continue;
    }
    if (normUrlForDedup && urlIndex[normUrlForDedup]) {
      console.log(`[EMAIL-PARSER] DUPLICATE — URL already in DB as ${urlIndex[normUrlForDedup]}. Skipping block.`);
      continue;
    }

    const meta = await fetchAmazonMeta(resolvedUrl);
    if (meta?.asin && !asin) asin = meta.asin;

    const affiliateUrl = normalizeAmazonUrl(resolvedUrl, asin);
    const imageUrl = meta?.image || emailImages[0] || null;
    const finalTitle = blockTitle || meta?.title || extractFallbackTitle(block) || 'Amazon Deal';
    const finalPrice = price || meta?.price || null;

    console.log(`[EMAIL-PARSER] ── Strategy 1 SAVE ──`);
    console.log(`[EMAIL-PARSER]   Title:         "${finalTitle}"`);
    console.log(`[EMAIL-PARSER]   Price:         ${finalPrice || 'none'}`);
    console.log(`[EMAIL-PARSER]   Discount:      ${discount || 'none'}%`);
    console.log(`[EMAIL-PARSER]   Code:          ${discountCode || 'none'}`);
    console.log(`[EMAIL-PARSER]   Affiliate URL: ${affiliateUrl}`);
    console.log(`[EMAIL-PARSER]   Tracking ID:   ${affiliateUrl?.includes(AFFILIATE_TAG) ? AFFILIATE_TAG + ' ✓' : 'MISSING ✗'}`);
    console.log(`[EMAIL-PARSER]   Image:         ${imageUrl || 'none — deal will be skipped by Facebook scheduler'}`);

    const deal = await saveDeal(store, { title: finalTitle, price: finalPrice, originalPrice, discount, discountCode, affiliateUrl, imageUrl, expiresOn });
    savedIds.push(deal.id);
    deals.push(deal);

    // Update dedup indexes so the next block in this same email doesn't duplicate
    if (asin) asinIndex[asin] = deal.id;
    const normUrl = normalizeUrl(deal.url);
    if (normUrl) urlIndex[normUrl] = deal.id;
    await store.setJSON('asin-index', asinIndex);
    await store.setJSON('url-index', urlIndex);
    console.log(`[EMAIL-PARSER]   Saved as ID: ${deal.id} | status: approved | dedup indexes updated`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 2 (top-level): If Strategy 1 found no deals, scan all Amazon URLs.
  // Handles "SAVE 40%", Lightning Deals, Prime Day, promo/coupon emails.
  // ════════════════════════════════════════════════════════════════════════════
  if (deals.length === 0) {
    console.log(`[EMAIL-PARSER] Strategy 1 found 0 deals — falling back to Strategy 2 (all-URL scan)`);
    const allUrls = extractAmazonUrls(cleanedText);
    console.log(`[EMAIL-PARSER] Strategy 2: ${allUrls.length} Amazon URL(s) found in full email`);

    const globalDiscount = cleanedText.match(/(\d+)\s*%\s*(?:off|discount|save)/i)?.[1] || null;
    const globalCode     = cleanedText.match(/(?:^|\n)\s*(?:code|coupon|promo)\s*[:\s]+([A-Z0-9]{4,20})/im)?.[1]
                         || cleanedText.match(/\bwith\s+code\s*[:\s]+([A-Z0-9]{4,20})/i)?.[1] || null;
    const globalExpMatch = cleanedText.match(/(?:End\s*Date|Expir(?:es?|ation)\s*(?:Date)?)\s*[:\s]+([^\n]+)/i);
    let globalExpiresOn = null;
    if (globalExpMatch?.[1]) {
      try { const d = new Date(globalExpMatch[1].trim()); if (!isNaN(d.getTime())) globalExpiresOn = d.toISOString(); } catch {}
    }

    console.log(`[EMAIL-PARSER] Strategy 2 globals — discount: ${globalDiscount || 'none'}%, code: ${globalCode || 'none'}`);

    for (const rawUrl of allUrls) {
      let asin = rawUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
      if (!asin) {
        const r = await followRedirectForAsin(rawUrl);
        asin = r.asin || null;
      }
      console.log(`[EMAIL-PARSER] Strategy 2 processing URL: ${rawUrl} | ASIN: ${asin || 'none'}`);

      // ── DEDUP CHECK (Strategy 2) ─────────────────────────────────────────
      const affiliateUrlForDedup = normalizeAmazonUrl(rawUrl, asin);
      const normUrlForDedup = normalizeUrl(affiliateUrlForDedup);
      if (asin && asinIndex[asin]) {
        console.log(`[EMAIL-PARSER] DUPLICATE — ASIN ${asin} already in DB as ${asinIndex[asin]}. Skipping.`);
        continue;
      }
      if (normUrlForDedup && urlIndex[normUrlForDedup]) {
        console.log(`[EMAIL-PARSER] DUPLICATE — URL already in DB as ${urlIndex[normUrlForDedup]}. Skipping.`);
        continue;
      }

      const meta = await fetchAmazonMeta(rawUrl);
      if (meta?.asin && !asin) asin = meta.asin;

      const affiliateUrl = normalizeAmazonUrl(rawUrl, asin);
      const imageUrl = meta?.image || emailImages[0] || null;

      // For "SAVE XX%" promotional emails, try to build title from discount + product name
      let finalTitle = meta?.title || null;
      if (!finalTitle && globalDiscount) {
        const promoTitle = extractFallbackTitle(cleanedText);
        finalTitle = promoTitle || `Save ${globalDiscount}% — Amazon Deal`;
      }
      finalTitle = finalTitle || extractFallbackTitle(cleanedText) || 'Amazon Deal';

      console.log(`[EMAIL-PARSER] ── Strategy 2 SAVE ──`);
      console.log(`[EMAIL-PARSER]   Title:         "${finalTitle}"`);
      console.log(`[EMAIL-PARSER]   Price:         ${meta?.price || 'none'}`);
      console.log(`[EMAIL-PARSER]   Discount:      ${globalDiscount || 'none'}%`);
      console.log(`[EMAIL-PARSER]   Code:          ${globalCode || 'none'}`);
      console.log(`[EMAIL-PARSER]   Affiliate URL: ${affiliateUrl}`);
      console.log(`[EMAIL-PARSER]   Tracking ID:   ${affiliateUrl?.includes(AFFILIATE_TAG) ? AFFILIATE_TAG + ' ✓' : 'MISSING ✗'}`);
      console.log(`[EMAIL-PARSER]   Image:         ${imageUrl || 'none — deal will be skipped by Facebook scheduler'}`);

      const deal = await saveDeal(store, {
        title: finalTitle, price: meta?.price || null, originalPrice: null,
        discount: globalDiscount, discountCode: globalCode,
        affiliateUrl, imageUrl, expiresOn: globalExpiresOn,
      });
      savedIds.push(deal.id);
      deals.push(deal);

      // Update dedup indexes after each save
      if (asin) asinIndex[asin] = deal.id;
      const normUrl = normalizeUrl(deal.url);
      if (normUrl) urlIndex[normUrl] = deal.id;
      await store.setJSON('asin-index', asinIndex);
      await store.setJSON('url-index', urlIndex);
      console.log(`[EMAIL-PARSER]   Saved as ID: ${deal.id} | status: approved | dedup indexes updated`);
    }
  }

  if (deals.length === 0) {
    console.log(`[EMAIL-PARSER] ✗ No deals saved. emailBody length: ${emailBody.length}. cleanedText preview: "${cleanedText.substring(0, 200)}"`);
  } else {
    console.log(`[EMAIL-PARSER] ✓ Saved ${deals.length} deal(s): ${savedIds.join(', ')}`);
  }

  return new Response(JSON.stringify({
    success: true,
    count:    deals.length,
    ids:      savedIds,
    deals,
    title:    deals[0]?.title    || null,
    price:    deals[0]?.price    || null,
    url:      deals[0]?.url      || null,
    imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/submit-email-deal' };
