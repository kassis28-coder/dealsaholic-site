// email-extraction-engine.mjs
// Three-phase pipeline: Extract → Format → Save to pending
//
// PHASE 1 → EXTRACT: Email is split into numbered product blocks (1, 2, US01…).
// PHASE 2 → FORMAT: Fields placed into the canonical 7-field sequence.
// PHASE 3 → SAVE: Each deal written to Netlify Blobs 'submissions' store with
//           status 'pending' for human review in the admin panel.
//
// IMAGE STRATEGY (in order):
//   1. extractImageForSection() — finds Amazon CDN URLs in raw email HTML.
//   2. fetchAmazonProductImage(asin) — fetches the Amazon product page and
//      extracts og:image or any m.media-amazon.com CDN URL.
//   3. downloadAndStoreImage(asin, imageUrl) — downloads the actual image
//      bytes and stores in Netlify Blobs "deal-images" store, then sets
//      imageUrl to https://deals-aholic.com/api/deal-image?id={asin}
//      so the image is hosted on our domain (no blocked CDN URLs).
//
// Saves to 'submissions' store + updates 'index' so admin panel can see deals.
// Affiliate tag from AMAZON_PARTNER_TAG env var. All deals go to PENDING.

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

// Downloads the image at imageUrl and stores binary in Netlify Blobs "deal-images".
// Returns our hosted URL (https://deals-aholic.com/api/deal-image?id={asin})
// or null on failure. Safe to call repeatedly — skips if already stored.
async function downloadAndStoreImage(asin, imageUrl) {
  if (!asin || !imageUrl) return null;
  try {
    const imageStore = getStore('deal-images');

    // Skip if already stored
    const existing = await imageStore.getMetadata(asin).catch(() => null);
    if (existing) return `https://deals-aholic.com/api/deal-image?id=${asin}`;

    // Download image bytes
    const imgRes = await fetch(imageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(10000),
    });
    if (!imgRes.ok) return null;

    const buffer = await imgRes.arrayBuffer();
    if (buffer.byteLength < 1000) return null; // skip tiny/broken images

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
  } catch {
    return url;
  }
}

function extractAsin(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

function extractImageForSection(rawHtml, productUrl, nextProductUrl) {
  // htmlToText decodes &amp; → & so URL in plain text may not match rawHtml.
  // Try both the decoded URL and the HTML-encoded version.
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

// ─── Strategy 2: Fetch Amazon product page and extract image URL ──────────────
// Used when the email HTML doesn't contain an image for this product.
// Fetches the Amazon product page and pulls og:image or the first CDN image.
// Returns a direct URL (link) — no download or re-hosting needed.

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

    // Try og:image meta tag — most reliable
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith('http')) return ogMatch[1];

    // Fallback: first large m.media-amazon.com CDN image
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
1. productName   — The product title/name only. NEVER include a % or promo code here.
2. discountPercent — The discount percentage (e.g. "50% off", "30%"). null if not stated.
3. promoCode     — The discount/promo code (letters + numbers only). null if none.
4. dealPrice      — The deal/discount price (e.g. "$19.98"). If a range, return only the first value.
5. amazonUrl       — The Amazon link (full URL starting with https://www.amazon.com/...).
6. expirationDate — The end/expiration date. Ignore start dates.
7. imageUrl        — null (always return null for this field).

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

export default async (req) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), {
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
      return new Response(JSON.stringify({ error: 'No email content received.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // PHASE 1 — EXTRACT
    const emailText = htmlToText(rawHtml) || plainText;
    let blocks = splitIntoProductBlocks(emailText);

    if (!blocks || blocks.length === 0) {
      const allUrls = findAmazonUrls(emailText);
      if (allUrls.length === 0) {
        return new Response(JSON.stringify({ error: 'No product blocks or Amazon URLs found.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      blocks = [{ position: 1, blockNum: '1', section: emailText }];
    }

    const allUrlsForImages = findAmazonUrls(rawHtml + '\n' + emailText);
    const deals = [];
    let totalInputTokens = 0, totalOutputTokens = 0;

    for (const block of blocks) {
      const { position, section } = block;
      const blockUrls  = findAmazonUrls(section);
      const primaryUrl = blockUrls[0] || null;
      const nextUrl    = allUrlsForImages[allUrlsForImages.indexOf(primaryUrl) + 1] || null;
      const asin         = primaryUrl ? extractAsin(primaryUrl) : null;
      const affiliateUrl = primaryUrl ? addAffiliateTag(primaryUrl) : null;

      // Strategy 1: find image URL embedded in the email HTML
      let imageUrl = primaryUrl ? extractImageForSection(rawHtml, primaryUrl, nextUrl) : null;

            // Strategy 2: fetch the Amazon product page if no image found in email
      if (!imageUrl && asin) {
        imageUrl = await fetchAmazonProductImage(asin);
        console.log(`[img] ASIN ${asin} → ${imageUrl ? 'fetched from product page' : 'not found'}`);
      }

      // Strategy 3: download the image bytes and host on our domain
      if (imageUrl && asin) {
        const hostedUrl = await downloadAndStoreImage(asin, imageUrl);
        if (hostedUrl) {
          console.log(`[img] ASIN ${asin} → downloaded and hosted at ${hostedUrl}`);
          imageUrl = hostedUrl;
        }
      }

      const result = await extractFromBlock(section, position, apiKey);
      totalInputTokens  += result.tokens?.input_tokens  || 0;
      totalOutputTokens += result.tokens?.output_tokens || 0;

      // PHASE 2 — FORMAT
      const deal = formatDeal(
        result.ok ? result.fields : null,
        affiliateUrl, imageUrl, position,
        {
          extractionOk:    result.ok,
          extractionError: result.ok ? null : result.error,
          asin,
          blockNum:        block.blockNum,
          sectionLength:   section.length,
          sectionPreview:  section.slice(0, 300),
        }
      );
      deals.push(deal);
    }

    // PHASE 3 ₀ SAVE to submissions store (same store the admin panel reads)
    // Uses submissions + index pattern so deals appear in Pending and Email Deals tabs.
    const store   = getStore('submissions');
    const saved   = [];
    const skipped = [];

    for (const deal of deals) {
      if (!deal.productName) {
        skipped.push({ position: deal.position, reason: 'no productName extracted' });
        continue;
      }

      const asin = deal._meta.asin;

      // Dedup: check asin-index in submissions store
      if (asin) {
        const existing = await store.get(`asin-index:${asin}`, { type: 'text' }).catch(() => null);
        if (existing) {
          skipped.push({ position: deal.position, reason: 'duplicate ASIN', asin });
          continue;
        }
      }

      const id = `email-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      // Parse expiresOn — default 7 days from now
      let expiresOn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      if (deal.expirationDate) {
        try {
          const parsed = new Date(deal.expirationDate);
          if (!isNaN(parsed.getTime())) expiresOn = parsed.toISOString();
        } catch { /* keep default */ }
      }

      // Schema matches what get-deals.mjs and admin.html expect
      const record = {
        id,
        title:        deal.productName,
        price:        deal.dealPrice    || null,
        originalPrice: null,
        discount:     deal.discountPercent
                        ? (parseInt(deal.discountPercent) || deal.discountPercent)
                        : null,
        discountCode: deal.promoCode    || null,
        url:          deal.amazonUrl    || null,
        imageUrl:     deal.imageUrl     || null,
        expiresOn,
        asin:         asin              || null,
        source:       'email',
        status:       'pending',
        sponsored:    false,
        createdAt:    new Date().toISOString(),
      };

      await store.setJSON(id, record);

      // Update the index so admin panel can enumerate all submissions
      let index = [];
      try { index = await store.get('index', { type: 'json' }) || []; } catch { index = []; }
      index.unshift(id);
      await store.setJSON('index', index);

      // Store ASIN dedup marker
      if (asin) {
        await store.set(`asin-index:${asin}`, id);
      }

      saved.push({ position: deal.position, id, title: deal.productName });
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
