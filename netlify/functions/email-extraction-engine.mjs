// email-extraction-engine.mjs
// Three-phase pipeline: Extract → Format → Save to pending
//
// IMAGE STRATEGY (in order):
// 1. extractImageForSection() — finds Amazon CDN URLs in raw email HTML.
// 2. Position-based fallback — uses Nth image in HTML for Nth product block.
// 3. fetchAmazonProductImage(asin) — fetches Amazon og:image from product page.
// 4. downloadAndStoreImage(asin, imageUrl) — hosts image on our domain.
//
// URL STRATEGY:
// - findAmazonUrls() finds direct Amazon URLs in the email text.
// - resolveTrackerUrls() follows click-tracker redirects (klclick, ctrk, etc.)
//   to discover Amazon URLs when none appear directly in the email.

import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_PRODUCTS = 20;

function htmlToText(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitIntoProductBlocks(text) {
  const markerRe = /(?:^|\n)[ \t]*(?:(?:deal|product)[ \t]*)?(?:\bUS\d+\b|\b\d+\b)[ \t]*-?[ \t]*\n/gi;
  const positions = [];
  let match;
  while ((match = markerRe.exec(text)) !== null) {
    const markerStart = match.index === 0 ? 0 : match.index + 1;
    const contentStart = match.index + match[0].length;
    positions.push({ blockNum: match[1], markerStart, contentStart });
  }
  if (positions.length === 0) return null;
  return positions.slice(0, MAX_PRODUCTS).map((p, i) => {
    const end = i < positions.length - 1 ? positions[i + 1].markerStart : text.length;
    return { position: i + 1, blockNum: p.blockNum, section: text.slice(p.contentStart, end).trim() };
  });
}

// Extract all meaningful product images from email HTML in document order
function extractAllProductImages(html) {
  if (!html) return [];
  const images = [];
  const pattern = /<img\b[^>]+>/gi;
  let m;
  while ((m = pattern.exec(html)) !== null) {
    const tag = m[0];
    const src = (tag.match(/src=["']([^"']+)["']/i) || [])[1];
    if (!src) continue;
    if (/cleardot|spacer|tracking|pixel|1x1|logo|avatar|icon/i.test(src)) continue;
    const width = parseInt((tag.match(/width=["']?(\d+)/i) || ['', '0'])[1]);
    if (width > 0 && width < 80) continue;
    images.push(src);
  }
  // Skip first image (usually newsletter logo/header)
  return images.length > 1 ? images.slice(1) : images;
}

// Follow tracker redirect links in parallel to discover Amazon URLs
async function resolveTrackerUrls(html) {
  if (!html) return [];
  const seen = new Set();
  const trackerUrls = [];
  const hrefPattern = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = hrefPattern.exec(html)) !== null) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    // Only follow URLs that look like click-trackers (not direct Amazon/unsubscribe)
    if (/klclick|ctrk\.|clicktrack|redirect|go\.hip2save|dmtrk/i.test(url) && !seen.has(url)) {
      trackerUrls.push(url);
    }
  }
  if (!trackerUrls.length) return [];
  console.log(`[tracker] Following ${trackerUrls.length} tracker URLs...`);

  const resolved = await Promise.all(
    trackerUrls.slice(0, 25).map(async (url) => {
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: AbortSignal.timeout(4000),
        });
        return res.url;
      } catch { return null; }
    })
  );

  const amazonUrls = [...new Set(resolved.filter(u => u && /amazon\.com/i.test(u)))];
  console.log(`[tracker] Resolved to ${amazonUrls.length} Amazon URLs`);
  return amazonUrls;
}

async function downloadAndStoreImage(asin, imageUrl) {
  if (!asin || !imageUrl) return null;
  try {
    const imageStore = getStore('deal-images');
    const existing = await imageStore.getMetadata(asin).catch(() => null);
    if (existing) return `https://deals-aholic.com/api/deal-image?id=${asin}`;
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!imgRes.ok) return null;
    const buffer = await imgRes.arrayBuffer();
    if (buffer.byteLength < 1000) return null;
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    await imageStore.set(asin, buffer, { metadata: { contentType } });
    return `https://deals-aholic.com/api/deal-image?id=${asin}`;
  } catch (e) {
    console.warn(`[img-dl] Failed for ASIN ${asin}: ${e.message}`);
    return null;
  }
}

function findAmazonUrls(text) {
  const pattern = /https?:\/\/(?:www\.)?(?:amazon\.com|amzn\.to|amzn\.com|a\.co)\/[^\s"'<>)]+/gi;
  const seen = new Set();
  const urls = [];
  for (const url of (text.match(pattern) || [])) {
    const clean = url.replace(/[)>\s'"]+$/, '');
    if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
  }
  return urls;
}

function addAffiliateTag(url) {
  const tag = process.env.AMAZON_PARTNER_TAG || 'daholic-20';
  try {
    const u = new URL(url);
    u.searchParams.set('tag', tag);
    return u.toString();
  } catch { return url; }
}

function extractAsin(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

function extractImageForSection(rawHtml, productUrl, nextProductUrl) {
  let start = rawHtml.indexOf(productUrl);
  if (start < 0) {
    const encoded = productUrl.replace(/&/g, '&amp;');
    start = rawHtml.indexOf(encoded);
  }
  if (start < 0) return null;
  const sectionStart = Math.max(0, start - 5000);
  const afterUrl = start + productUrl.length;
  const end = nextProductUrl ? rawHtml.indexOf(nextProductUrl, afterUrl) : rawHtml.length;
  const sectionEnd = end > afterUrl ? end : rawHtml.length;
  const htmlSlice = rawHtml.slice(sectionStart, sectionEnd);
  const pattern = /https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images\.amazon\.com|ecx\.images-amazon\.com)\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
  for (const img of (htmlSlice.match(pattern) || [])) {
    const clean = img.split('?')[0];
    if (!/_SL75_|_SS40_|thumbnail/i.test(clean)) return clean;
  }
  return null;
}

async function fetchAmazonProductImage(asin) {
  if (!asin) return null;
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith('http')) return ogMatch[1];
    const cdnPattern = /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
    for (const img of (html.match(cdnPattern) || [])) {
      const clean = img.split('?')[0];
      if (!/_SL75_|_SS40_|_AC_US\d+_|thumbnail/i.test(clean)) return clean;
    }
    return null;
  } catch (e) {
    console.log(`[img] fetchAmazonProductImage(${asin}) failed: ${e.message}`);
    return null;
  }
}

async function extractFromBlock(section, position, apiKey) {
  const prompt = `You are a deal extraction assistant. The text below is ONE product block (#${position}).
Extract EXACTLY these 7 fields. No guessing, no inferring — only what is explicitly written.

FIELDS:
1. productName — The product title/name only. NEVER include a % or promo code here.
2. discountPercent — The discount percentage (e.g. "50% off", "30%"). null if not stated.
3. promoCode — The discount/promo code (letters + numbers only). null if none.
4. dealPrice — The deal/discount price (e.g. "$19.98"). If a range, return only the first value.
5. amazonUrl — The Amazon link (full URL starting with https://www.amazon.com/...).
6. expirationDate — The end/expiration date. Ignore start dates.
7. imageUrl — null (always return null for this field).

RULES:
- If a field is absent, return null.
- promoCode: extract only the code itself (no %, no "off", no extra words).
- Do NOT copy data between products.

Return ONLY valid JSON with exactly these keys. No markdown, no explanation.

PRODUCT BLOCK #${position}:
---
${section.slice(0, 3000)}
---`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data.content?.[0]?.text?.trim() || '';
  const tokens = data.usage || {};
  try {
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return { ok: true, fields: JSON.parse(jsonText), raw, tokens };
  } catch (e) {
    return { ok: false, fields: null, raw, error: `JSON parse failed: ${e.message}`, tokens };
  }
}

function formatDeal(extracted, affiliateUrl, imageUrl, position, meta) {
  const f = extracted || {};
  const finalUrl = f.amazonUrl ? addAffiliateTag(f.amazonUrl) : affiliateUrl;
  return { position, productName: f.productName || null, dealPrice: f.dealPrice || null,
    promoCode: f.promoCode || null, discountPercent: f.discountPercent || null,
    amazonUrl: finalUrl || null, imageUrl, expirationDate: f.expirationDate || null, _meta: meta };
}

export default async (req) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

    let rawHtml = '', plainText = '';
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const b = await req.json();
      rawHtml = b.htmlBody || b.html || '';
      plainText = b.textBody || b.text || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f = await req.formData();
      rawHtml = f.get('htmlBody') || f.get('html') || '';
      plainText = f.get('textBody') || f.get('text') || '';
    } else {
      rawHtml = await req.text();
    }

    if (!rawHtml && !plainText) return new Response(JSON.stringify({ error: 'No email content received.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    // PHASE 1 — EXTRACT
    const emailText = htmlToText(rawHtml) || plainText;
    let blocks = splitIntoProductBlocks(emailText);

    // Find Amazon URLs in text
    let allUrlsForImages = findAmazonUrls(rawHtml + '\n' + emailText);

    // If no direct Amazon URLs, follow tracker links in the HTML to discover them
    if (allUrlsForImages.length === 0 && rawHtml) {
      allUrlsForImages = await resolveTrackerUrls(rawHtml);
    }

    // Position-based image fallback: extract all product images from HTML in order
    const positionImages = extractAllProductImages(rawHtml);
    console.log(`[img] Found ${positionImages.length} position-based images, ${allUrlsForImages.length} Amazon URLs`);

    if (!blocks || blocks.length === 0) {
      if (allUrlsForImages.length === 0) {
        return new Response(JSON.stringify({ error: 'No product blocks or Amazon URLs found.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      blocks = [{ position: 1, blockNum: '1', section: emailText }];
    }

    const deals = [];
    let totalInputTokens = 0, totalOutputTokens = 0;

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const { position, section } = block;
      const blockUrls = findAmazonUrls(section);
      const primaryUrl = blockUrls[0] || allUrlsForImages[i] || null;
      const nextUrl = allUrlsForImages[allUrlsForImages.indexOf(primaryUrl) + 1] || null;
      const asin = primaryUrl ? extractAsin(primaryUrl) : null;
      const affiliateUrl = primaryUrl ? addAffiliateTag(primaryUrl) : null;

      // Strategy 1: find Amazon CDN image in email HTML near the product URL
      let imageUrl = primaryUrl ? extractImageForSection(rawHtml, primaryUrl, nextUrl) : null;

      // Strategy 2: position-based image from email HTML
      if (!imageUrl && positionImages[i]) {
        imageUrl = positionImages[i];
        console.log(`[img] Block ${position} → position image: ${imageUrl?.substring(0, 60)}`);
      }

      // Strategy 3: fetch og:image from Amazon product page
      if (!imageUrl && asin) {
        imageUrl = await fetchAmazonProductImage(asin);
        console.log(`[img] ASIN ${asin} → ${imageUrl ? 'fetched from product page' : 'not found'}`);
      }

      // Strategy 4: download bytes and host on our domain
      if (imageUrl && asin) {
        const hostedUrl = await downloadAndStoreImage(asin, imageUrl);
        if (hostedUrl) {
          console.log(`[img] ASIN ${asin} → hosted at ${hostedUrl}`);
          imageUrl = hostedUrl;
        }
      }

      const result = await extractFromBlock(section, position, apiKey);
      totalInputTokens += result.tokens?.input_tokens || 0;
      totalOutputTokens += result.tokens?.output_tokens || 0;

      deals.push(formatDeal(
        result.ok ? result.fields : null,
        affiliateUrl, imageUrl, position,
        { extractionOk: result.ok, extractionError: result.ok ? null : result.error,
          asin, blockNum: block.blockNum, sectionLength: section.length, sectionPreview: section.slice(0, 300) }
      ));
    }

    // PHASE 3 — SAVE to submissions store
    const store = getStore('submissions');
    const saved = [], skipped = [];

    for (const deal of deals) {
      if (!deal.productName) { skipped.push({ position: deal.position, reason: 'no productName extracted' }); continue; }
      const asin = deal._meta.asin;
      if (asin) {
        const existing = await store.get(`asin-index:${asin}`, { type: 'text' }).catch(() => null);
        if (existing) { skipped.push({ position: deal.position, reason: 'duplicate ASIN', asin }); continue; }
      }

      const id = `email-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      let expiresOn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      if (deal.expirationDate) {
        try {
          const parsed = new Date(deal.expirationDate);
          if (!isNaN(parsed.getTime())) expiresOn = parsed.toISOString();
        } catch {}
      }

      const record = {
        id, title: deal.productName, price: deal.dealPrice || null, originalPrice: null,
        discount: deal.discountPercent ? (parseInt(deal.discountPercent) || deal.discountPercent) : null,
        discountCode: deal.promoCode || null, url: deal.amazonUrl || null,
        imageUrl: deal.imageUrl || null, expiresOn, asin: asin || null,
        source: 'email', status: 'pending', sponsored: false, createdAt: new Date().toISOString(),
      };

      await store.setJSON(id, record);
      let index = [];
      try { index = await store.get('index', { type: 'json' }) || []; } catch { index = []; }
      index.unshift(id);
      await store.setJSON('index', index);
      if (asin) await store.set(`asin-index:${asin}`, id);
      saved.push({ position: deal.position, id, title: deal.productName });
    }

    return new Response(JSON.stringify({
      summary: { blocksFound: blocks.length, extracted: deals.length, saved: saved.length, skipped: skipped.length,
        model: MODEL, tokensUsed: { input: totalInputTokens, output: totalOutputTokens } },
      saved, skipped, deals,
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/email-extraction-engine' };
