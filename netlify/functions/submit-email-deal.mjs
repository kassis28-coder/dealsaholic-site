import { getStore } from "@netlify/blobs";

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const AFFILIATE_TAG = 'kethya08-20';
const AMAZON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml',
};

// ── AFFILIATE LINK — every Amazon URL MUST pass through this ─────────────────
// normalizeAmazonUrl() → appendAffiliateTag() → final saved URL
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
  // Prefer clean /dp/ URL when ASIN is known
  if (asin) return appendAffiliateTag(`https://www.amazon.com/dp/${asin}`);
  // Otherwise append tag to the raw URL (always — never skip)
  return appendAffiliateTag(rawUrl);
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

// Strategy A: og:image / twitter:image meta tags (attribute order-independent)
function extractOgImage(html) {
  // property before content
  return html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    // content before property
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1]
    // twitter:image property first
    || html.match(/<meta[^>]+property=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    // twitter:image name first
    || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    // content before twitter:image name
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i)?.[1]
    || null;
}

// Strategy B: Amazon CDN <img> tags and bare URLs in email HTML
function extractImagesFromEmailHtml(rawHtml) {
  const seen = new Set();
  const images = [];

  const add = (url) => {
    if (url && !seen.has(url)) { seen.add(url); images.push(url); }
  };

  // <img src="..."> tags with Amazon CDN hosts
  for (const m of rawHtml.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (src && (
      src.includes('m.media-amazon.com') ||
      src.includes('images-na.ssl-images-amazon.com') ||
      src.includes('images-amazon.com') ||
      src.includes('ssl-images-amazon.com')
    )) add(src);
  }

  // Bare Amazon CDN image URLs anywhere in the HTML
  for (const m of rawHtml.matchAll(/https?:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-amazon\.com|ssl-images-amazon\.com)\/images\/[^\s"'<>]+/gi)) {
    add(m[0]);
  }

  // Filter out known tiny thumbnails
  return images.filter(u =>
    !u.includes('._SL75_') && !u.includes('._SS40_') && !u.includes('_SX38_') &&
    !u.includes('._SL30_') && !u.includes('1x1') && !u.includes('pixel')
  );
}

// Strategy C: fetch product page for og:image when only ASIN is known
async function fetchProductPageImage(asin) {
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, { headers: AMAZON_HEADERS, redirect: 'follow' });
    if (!res.ok) return null;
    const img = extractOgImage(await res.text());
    return img;
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

    // Image: try og:image first
    let image = extractOgImage(html);

    // Promo pages stay at promocode URL — scan body for /dp/ ASIN links
    if (!asin || !image) {
      const bodyAsin = html.match(/\/dp\/([A-Z0-9]{10})[/"'?\s]/i)?.[1];
      if (bodyAsin && !asin) asin = bodyAsin;
      // Fetch real product page for image if promo page had no og:image
      if (asin && !image) image = await fetchProductPageImage(asin);
    }

    // Fallback: Amazon CDN images embedded in the page HTML itself
    if (!image) {
      const pageImages = extractImagesFromEmailHtml(html);
      if (pageImages.length > 0) image = pageImages[0];
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

// ── EXTRACT ALL AMAZON URLs (Strategy 2 — used as fallback) ─────────────────
function extractAmazonUrls(text) {
  const patterns = [
    // /dp/ and /gp/product/ links (ASIN-bearing)
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    // Promo / coupon / deal / goldbox / subscribe-and-save / savings
    /https?:\/\/(?:www\.)?amazon\.com\/(?:promocode|promotion|gp\/promocode|deal|gp\/goldbox|gp\/subscribe-and-save|savings|coupons|gp\/deal)[^\s"'<>]*/gi,
    // Any other amazon.com URL (catch-all)
    /https?:\/\/(?:www\.)?amazon\.com\/[a-zA-Z0-9\-_\/+%?=&#@!.]{5,}[^\s"'<>]*/gi,
    // Short links
    /https?:\/\/(?:amzn\.to|a\.co)\/[A-Za-z0-9\/]+/gi,
  ];
  const seen = new Set();
  const urls = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      const url = m[0].replace(/[.,;)\]>'"]+$/, ''); // strip trailing punctuation
      if (!seen.has(url)) { seen.add(url); urls.push(url); }
    }
  }
  return urls;
}

// ── STRIP HTML TAGS ───────────────────────────────────────────────────────────
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
    /(?:^|\n)\s*\d+\s+Product\s*[Nn]ame/g,   // "1 Product name: ..."
    /(?:^|\n)\s*\d+[.)]\s*(?:\n|$)/g,          // "1." or "1)" on its own line
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
  return [text]; // single block fallback
}

// ── STRATEGY 1: Extract fields from a structured product block ───────────────
function extractProductData(block) {
  // Title from explicit "Product name:" label
  const titleMatch = block.match(/Product\s*[Nn]ame\s*[:\s]+([^\n]+)/i);
  let title = titleMatch?.[1]?.trim().substring(0, 150) || null;
  if (title) title = title
    .replace(/amazon\.com\s*/gi, '').replace(/\s*[|:]\s*amazon\b.*/i, '')
    .replace(/^\d+%\s*off\s+/i, '')
    .replace(/^hotsales\s+/i, '')
    .replace(/\s*[—–]\s*only\s+\$[\d.]+[^!]*!?\s*$/i, '')
    .trim();

  // Sale price (explicit labels only — NOT "Reg. Price")
  const priceMatch = block.match(/(?:Deal\s*Price|Final\s*Price|Sale\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;

  // Original price (including "Reg. Price")
  const origMatch = block.match(/(?:Original\s*Price|Reg\.?\s*Price|Was|Regular\s*Price|List\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const originalPrice = origMatch ? '$' + origMatch[1].replace(/,/g, '') : null;

  // Discount percentage
  const discountMatch = block.match(/(\d+)\s*%\s*(?:off|discount|save)/i);
  const discount = discountMatch?.[1] || null;

  // Coupon code — line-start first, then "with code:XXX" mid-line
  const codeMatch = block.match(/(?:^|\n)\s*(?:code|coupon|promo)\s*[:\s]+([A-Z0-9]{4,20})/im)
    || block.match(/\bwith\s+code\s*[:\s]+([A-Z0-9]{4,20})/i)
    || block.match(/\bcode\s*[:\s]+([A-Z0-9]{4,20})\b/i);
  const discountCode = codeMatch?.[1]?.trim() || null;

  // URLs — ALL Amazon URL types, in priority order
  const dpMatch    = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>]*/i);
  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:promocode|promotion|gp\/promocode|deal|gp\/goldbox|gp\/subscribe-and-save|savings|coupons|gp\/deal)[^\s"'<>]*/i);
  const shortMatch = block.match(/https?:\/\/(?:amzn\.to|a\.co)\/[A-Za-z0-9\/]+/i);
  const anyAmazon  = block.match(/https?:\/\/(?:www\.)?amazon\.com\/[a-zA-Z0-9\-_\/+%?=&#@!.]{5,}[^\s"'<>]*/i);

  const asin   = dpMatch?.[1] || null;
  const rawUrl = dpMatch?.[0] || promoMatch?.[0] || shortMatch?.[0] || anyAmazon?.[0] || null;

  // Expiration date
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
  // "Save X% on Product Name"
  const saveMatch = text.match(/save\s+\d+%\s+(?:on\s+)?(.{10,150}?)(?:\n|$)/i);
  if (saveMatch) return saveMatch[1].trim().substring(0, 150);
  // "X% off Product Name"
  const offMatch = text.match(/\d+%\s+off\s+(?:on\s+)?(.{10,150}?)(?:\n|$)/i);
  if (offMatch) return offMatch[1].trim().substring(0, 150);
  // First non-empty non-URL line
  const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('http') && l.length > 8);
  return lines[0]?.substring(0, 150) || null;
}

// ── SAVE ONE DEAL to Netlify Blobs ───────────────────────────────────────────
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
    status:        'pending',
    sponsored:     false,
    facebookPosted: false,
    telegramPosted: false,
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

  // ── STRATEGY 3: Extract Amazon CDN images from raw email HTML BEFORE stripping
  const emailImages = extractImagesFromEmailHtml(rawHtml);
  console.log(`[EMAIL-PARSER] Subject: "${emailTitle}" | CDN images in email HTML: ${emailImages.length}`);

  const cleanedText = cleanEmailContent(stripHtml(rawHtml));

  const store   = getStore('submissions');
  const savedIds = [];
  const deals   = [];

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

    // ── STRATEGY 2 (block-level): if structured parse found no URL, scan for any Amazon URL
    let resolvedUrl = structuredUrl;
    if (!resolvedUrl) {
      const fallbackUrls = extractAmazonUrls(block);
      resolvedUrl = fallbackUrls[0] || null;
      if (resolvedUrl) console.log(`[EMAIL-PARSER] Strategy 2 (block-level) URL: ${resolvedUrl}`);
    }

    if (!resolvedUrl) {
      console.log(`[EMAIL-PARSER] SKIP block — no Amazon URL. Preview: "${block.substring(0, 80).replace(/\n/g, ' ')}"`);
      continue;
    }

    let asin = blockAsin;
    if (!asin) {
      const r = await followRedirectForAsin(resolvedUrl);
      asin = r.asin || null;
    }

    // Fetch Amazon page metadata (title, image, ASIN from page)
    const meta = await fetchAmazonMeta(resolvedUrl);
    if (meta?.asin && !asin) asin = meta.asin;

    // ── AFFILIATE URL: normalizeAmazonUrl → appendAffiliateTag → saved URL ──
    const affiliateUrl = normalizeAmazonUrl(resolvedUrl, asin);

    // ── IMAGE: try in order: og:image from page → email CDN image → null ────
    const imageUrl = meta?.image || emailImages[0] || null;

    // ── TITLE: structured label → Amazon meta → fallback text extraction ─────
    const finalTitle = blockTitle || meta?.title || extractFallbackTitle(block) || 'Amazon Deal';
    const finalPrice = price || meta?.price || null;

    console.log(`[EMAIL-PARSER] SAVE (Strategy 1):`);
    console.log(`  Title:        "${finalTitle}"`);
    console.log(`  Raw URL:      ${resolvedUrl}`);
    console.log(`  Affiliate URL:${affiliateUrl}`);
    console.log(`  Image:        ${imageUrl || 'null'}`);
    console.log(`  Code:         ${discountCode || 'none'} | Discount: ${discount || 'none'}%`);

    const deal = await saveDeal(store, { title: finalTitle, price: finalPrice, originalPrice, discount, discountCode, affiliateUrl, imageUrl, expiresOn });
    savedIds.push(deal.id);
    deals.push(deal);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 2 (top-level): If Strategy 1 found no deals at all,
  // extract every Amazon URL from the full email text.
  // This handles "Save 40%", Lightning Deals, Prime Day, coupon emails, etc.
  // ════════════════════════════════════════════════════════════════════════════
  if (deals.length === 0) {
    console.log(`[EMAIL-PARSER] Strategy 1 found 0 deals. Trying Strategy 2 (all-URL scan)...`);
    const allUrls = extractAmazonUrls(cleanedText);
    console.log(`[EMAIL-PARSER] Strategy 2 found ${allUrls.length} Amazon URL(s)`);

    // Global coupon/discount from email body
    const globalDiscount   = cleanedText.match(/(\d+)\s*%\s*(?:off|discount|save)/i)?.[1] || null;
    const globalCode       = cleanedText.match(/(?:^|\n)\s*(?:code|coupon|promo)\s*[:\s]+([A-Z0-9]{4,20})/im)?.[1]
                           || cleanedText.match(/\bwith\s+code\s*[:\s]+([A-Z0-9]{4,20})/i)?.[1] || null;
    const globalExpMatch   = cleanedText.match(/(?:End\s*Date|Expir(?:es?|ation)\s*(?:Date)?)\s*[:\s]+([^\n]+)/i);
    let globalExpiresOn = null;
    if (globalExpMatch?.[1]) {
      try { const d = new Date(globalExpMatch[1].trim()); if (!isNaN(d.getTime())) globalExpiresOn = d.toISOString(); } catch {}
    }

    for (const rawUrl of allUrls) {
      let asin = rawUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
      if (!asin) {
        const r = await followRedirectForAsin(rawUrl);
        asin = r.asin || null;
      }

      const meta = await fetchAmazonMeta(rawUrl);
      if (meta?.asin && !asin) asin = meta.asin;

      // ── AFFILIATE URL ──────────────────────────────────────────────────────
      const affiliateUrl = normalizeAmazonUrl(rawUrl, asin);

      // ── IMAGE ──────────────────────────────────────────────────────────────
      const imageUrl = meta?.image || emailImages[0] || null;

      // ── TITLE ──────────────────────────────────────────────────────────────
      const finalTitle = meta?.title || extractFallbackTitle(cleanedText) || 'Amazon Deal';

      console.log(`[EMAIL-PARSER] SAVE (Strategy 2):`);
      console.log(`  Title:        "${finalTitle}"`);
      console.log(`  Raw URL:      ${rawUrl}`);
      console.log(`  Affiliate URL:${affiliateUrl}`);
      console.log(`  Image:        ${imageUrl || 'null'}`);
      console.log(`  Code:         ${globalCode || 'none'} | Discount: ${globalDiscount || 'none'}%`);

      const deal = await saveDeal(store, {
        title: finalTitle, price: meta?.price || null, originalPrice: null,
        discount: globalDiscount, discountCode: globalCode,
        affiliateUrl, imageUrl, expiresOn: globalExpiresOn,
      });
      savedIds.push(deal.id);
      deals.push(deal);
    }
  }

  if (deals.length === 0) {
    console.log(`[EMAIL-PARSER] No deals found. emailBody length: ${emailBody.length}. cleanedText preview: "${cleanedText.substring(0, 200)}"`);
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
