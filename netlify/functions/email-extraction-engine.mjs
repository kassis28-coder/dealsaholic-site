// email-extraction-engine.mjs
// Three-phase pipeline: Extract → Format → Save to pending
//
// PHASE 1 → EXTRACT: Email is split into numbered product blocks (1, 2, US01…).
//           Claude reads each block in full and extracts the 7 canonical fields.
// PHASE 2 → FORMAT: Fields placed into the canonical 7-field sequence.
// PHASE 3 → SAVE: Each deal written to Netlify Blobs with status 'pending'
//           for human review in the admin panel before going live.
//
// Image extraction — 4-strategy cascade:
//   1. Amazon CDN image URLs found in the email HTML
//   2. Any <img src> tag in the email HTML section (catches seller-hosted images)
//   3. Fetch directly from product URL (handles promo/redirect URLs like amazon.com/promocode/...)
//   4. ASIN fallback: fetch og:image from the Amazon product page

import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_PRODUCTS = 20;

// ─── Strip HTML to readable text ─────────────────────────────────────────────

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

// ─── Split email into numbered product blocks ─────────────────────────────────

function splitIntoProductBlocks(text) {
  const markerRe = /(?:^|\n)[ \t]*(?:(?:deal|product)[ \t]*)?(\bUS\d+\b|\b\d+\b)[ \t]*-?[ \t]*\n/gi;
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
    const section = text.slice(p.contentStart, end).trim();
    return { position: i + 1, blockNum: p.blockNum, section };
  });
}

// ─── Find all Amazon URLs in a text string ────────────────────────────────────

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

// ─── Add affiliate tag ────────────────────────────────────────────────────────

function addAffiliateTag(url) {
  const tag = process.env.AMAZON_PARTNER_TAG || 'daholic-20';
  try {
    const u = new URL(url);
    u.searchParams.set('tag', tag);
    return u.toString();
  } catch {
    return url;
  }
}

// ─── Extract ASIN from URL ────────────────────────────────────────────────────

function extractAsin(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

// ─── Strategy 1 + 2: Extract image from email HTML ───────────────────────────
// Strategy 1: Amazon CDN image URLs (preferred — highest quality)
// Strategy 2: Any <img src> tag in the section (catches seller-hosted images)

function extractImageForSection(rawHtml, productUrl, nextProductUrl) {
  const start = rawHtml.indexOf(productUrl);
  if (start < 0) return null;

  const sectionStart = Math.max(0, start - 5000);
  const afterUrl = start + productUrl.length;
  const end = nextProductUrl ? rawHtml.indexOf(nextProductUrl, afterUrl) : rawHtml.length;
  const sectionEnd = end > afterUrl ? end : rawHtml.length;
  const htmlSlice = rawHtml.slice(sectionStart, sectionEnd);

  // Strategy 1: Amazon CDN images
  const amazonPattern = /https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images\.amazon\.com|ecx\.images-amazon\.com)\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
  for (const img of (htmlSlice.match(amazonPattern) || [])) {
    const clean = img.split('?')[0];
    if (!/_SL75_|_SS40_|thumbnail/i.test(clean)) return clean;
  }

  // Strategy 2: any <img src="..."> tag (seller-hosted or other CDN images)
  const imgTagPattern = /<img[^>]+src=["']([^"']+)["']/gi;
  let imgMatch;
  while ((imgMatch = imgTagPattern.exec(htmlSlice)) !== null) {
    const src = imgMatch[1];
    if (
      src.startsWith('http') &&
      /\.(jpg|jpeg|png|webp)/i.test(src) &&
      !/_SL75_|_SS40_|thumbnail|spacer|pixel|tracking|1x1/i.test(src)
    ) {
      return src.split('?')[0];
    }
  }

  return null;
}

// ─── Strategy 3: fetch og:image from any Amazon URL (handles promo/redirect URLs) ───

async function fetchImageFromUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith('http')) return ogMatch[1].split('?')[0];

    const cdnPattern = /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
    for (const img of (html.match(cdnPattern) || [])) {
      const clean = img.split('?')[0];
      if (!/_SL75_|_SS40_|thumbnail/i.test(clean)) return clean;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Strategy 4: ASIN fallback — fetch og:image from Amazon product page ─────

async function fetchAsinImage(asin) {
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // og:image meta tag (most reliable)
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith('http')) return ogMatch[1].split('?')[0];

    // hiRes image from page data
    const hiResMatch = html.match(/"hiRes"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/);
    if (hiResMatch) return hiResMatch[1].split('?')[0];

    // landingImage src
    const landingMatch = html.match(/id=["']landingImage["'][^>]+src=["']([^"']+)["']/i);
    if (landingMatch?.[1]?.startsWith('http')) return landingMatch[1].split('?')[0];

    return null;
  } catch {
    return null;
  }
}

// ─── Claude extracts 7 fields from one product block ─────────────────────────

async function extractFromBlock(section, position, apiKey) {
  const prompt = `You are a deal extraction assistant. The text below is ONE product block (#${position}).
Extract EXACTLY these 7 fields. No guessing, no inferring — only what is explicitly written.

FIELDS:
1. productName   — The product title/name only. NEVER include a % or promo code here.
2. discountPercent — The discount percentage (e.g. "50% off", "30%"). null if not stated.
3. promoCode     — The discount/promo code (letters + numbers only, e.g. "V6WA8CIO"). null if none.
4. dealPrice     — The deal/discount price (e.g. "$19.98"). If a range, return only the first value.
5. amazonUrl     — The Amazon link (full URL starting with https://www.amazon.com/...).
6. expirationDate — The end/expiration date. Ignore start dates.
7. imageUrl      — null (images are fetched separately; always return null for this field).

RULES:
- If a field is absent, return null.
- promoCode: extract only the code itself (no %, no "off", no extra words).
- Do NOT copy data between products.
- Do NOT calculate anything.

Return ONLY a JSON object with exactly these keys:
{
  "productName": string|null,
  "discountPercent": string|null,
  "promoCode": string|null,
  "dealPrice": string|null,
  "amazonUrl": string|null,
  "expirationDate": string|null,
  "imageUrl": null
}

No markdown, no explanation. JSON only.

PRODUCT BLOCK #${position}:
---
${section.slice(0, 3000)}
---`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
      'content-type':      'application/json',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data   = await res.json();
  const raw    = data.content?.[0]?.text?.trim() || '';
  const tokens = data.usage || {};

  try {
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed   = JSON.parse(jsonText);
    return { ok: true, fields: parsed, raw, tokens };
  } catch (e) {
    return { ok: false, fields: null, raw, error: `JSON parse failed: ${e.message}`, tokens };
  }
}

// ─── Format into the canonical 7-field deal record ───────────────────────────

function formatDeal(extracted, affiliateUrl, imageUrl, position, meta) {
  const f = extracted || {};
  const finalUrl = f.amazonUrl ? addAffiliateTag(f.amazonUrl) : affiliateUrl;
  return {
    position,
    productName:     f.productName     || null,
    dealPrice:       f.dealPrice       || null,
    promoCode:       f.promoCode       || null,
    discountPercent: f.discountPercent || null,
    amazonUrl:       finalUrl          || null,
    imageUrl,
    expirationDate:  f.expirationDate  || null,
    _meta: meta,
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async (req) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment' }), {
        status: 500, headers: { 'Content-Type': 'application/json' },
      });
    }

    let rawHtml = '', plainText = '';
    const ct = req.headers.get('content-type') || '';

    if (ct.includes('application/json')) {
      const b  = await req.json();
      rawHtml   = b.htmlBody || b.html || '';
      plainText = b.textBody || b.text || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f  = await req.formData();
      rawHtml   = f.get('htmlBody') || f.get('html') || '';
      plainText = f.get('textBody') || f.get('text') || '';
    } else {
      rawHtml = await req.text();
    }

    if (!rawHtml && !plainText) {
      return new Response(JSON.stringify({ error: 'No email content received. Send htmlBody or textBody.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // PHASE 1 → EXTRACT
    const emailText = htmlToText(rawHtml) || plainText;
    let blocks = splitIntoProductBlocks(emailText);

    if (!blocks || blocks.length === 0) {
      const allUrls = findAmazonUrls(emailText);
      if (allUrls.length === 0) {
        return new Response(JSON.stringify({ error: 'No product blocks or Amazon URLs found in email.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      blocks = [{ position: 1, blockNum: '1', section: emailText }];
    }

    const allUrlsForImages = findAmazonUrls(rawHtml + '\n' + emailText);

    const deals = [];
    let totalInputTokens  = 0;
    let totalOutputTokens = 0;

    for (const block of blocks) {
      const { position, section } = block;

      const blockUrls  = findAmazonUrls(section);
      const primaryUrl = blockUrls[0] || null;
      const nextUrl    = allUrlsForImages[allUrlsForImages.indexOf(primaryUrl) + 1] || null;

      const asin         = primaryUrl ? extractAsin(primaryUrl) : null;
      const affiliateUrl = primaryUrl ? addAffiliateTag(primaryUrl) : null;

      // Image cascade:
      // 1+2: scan email HTML (Amazon CDN + any img tag)
      // 3: fetch directly from URL (handles promo/redirect URLs like amazon.com/promocode/...)
      // 4: fetch from amazon.com/dp/ASIN (standard product page)
      let imageUrl = primaryUrl ? extractImageForSection(rawHtml, primaryUrl, nextUrl) : null;
      if (!imageUrl && primaryUrl) {
        imageUrl = await fetchImageFromUrl(primaryUrl);
      }
      if (!imageUrl && asin) {
        imageUrl = await fetchAsinImage(asin);
      }

      const result = await extractFromBlock(section, position, apiKey);
      totalInputTokens  += result.tokens?.input_tokens  || 0;
      totalOutputTokens += result.tokens?.output_tokens || 0;

      // PHASE 2 → FORMAT
      const deal = formatDeal(
        result.ok ? result.fields : null,
        affiliateUrl,
        imageUrl,
        position,
        {
          extractionOk:    result.ok,
          extractionError: result.ok ? null : result.error,
          asin,
          blockNum:        block.blockNum,
          sectionLength:   section.length,
          sectionPreview:  section.slice(0, 300),
          imageSource:     imageUrl ? 'extracted' : 'none',
        }
      );
      deals.push(deal);
    }

    // PHASE 3 → SAVE to Netlify Blobs as 'pending'
    const store   = getStore('deals');
    const saved   = [];
    const skipped = [];

    for (const deal of deals) {
      if (!deal.productName) {
        skipped.push({ position: deal.position, reason: 'no productName extracted' });
        continue;
      }

      const asin     = deal._meta.asin;
      const dedupKey = asin
        ? `asin:${asin}`
        : `url:${Buffer.from(deal.amazonUrl || deal.productName).toString('base64').slice(0, 20)}`;

      const existing = await store.get(dedupKey, { type: 'json' }).catch(() => null);
      if (existing) {
        skipped.push({ position: deal.position, reason: 'duplicate', key: dedupKey });
        continue;
      }

      const dealRecord = {
        title:           deal.productName,
        price:           deal.dealPrice,
        promoCode:       deal.promoCode,
        discountPercent: deal.discountPercent,
        url:             deal.amazonUrl,
        image:           deal.imageUrl,
        expirationDate:  deal.expirationDate,
        asin:            asin || null,
        status:          'pending',
        source:          'email',
        createdAt:       new Date().toISOString(),
        emailPosition:   deal.position,
      };

      await store.set(dedupKey, JSON.stringify(dealRecord));
      saved.push({ position: deal.position, key: dedupKey, title: deal.productName });
    }

    return new Response(JSON.stringify({
      summary: {
        blocksFound: blocks.length,
        extracted:   deals.length,
        saved:       saved.length,
        skipped:     skipped.length,
        model:       MODEL,
        tokensUsed:  { input: totalInputTokens, output: totalOutputTokens },
      },
      saved,
      skipped,
      deals,
    }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/email-extraction-engine' };
