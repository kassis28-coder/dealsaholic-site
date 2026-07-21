// email-extraction-engine.mjs
// Three-phase pipeline: Extract â Format â Save to pending
//
// PHASE 1 â EXTRACT: Email is split into numbered product blocks (1, 2, US01â¦).
//           Claude reads each block in full and extracts the 7 canonical fields.
// PHASE 2 â FORMAT: Fields placed into the canonical 7-field sequence.
// PHASE 3 â SAVE: Each deal written to Netlify Blobs with status 'pending'
//           for human review in the admin panel before going live.
//
// Block boundaries come from numbered markers (lone digit lines or US01/US02).
// Data from block N can NEVER appear in block M.
//
// NO guessing. NO inferring.
// Affiliate tag added to every URL from AMAZON_PARTNER_TAG env var.
// All deals go to PENDING â nothing is auto-approved.

import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_PRODUCTS = 20;

// âââ Strip HTML to readable text âââââââââââââââââââââââââââââââââââââââââââââ

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

// âââ Split email into numbered product blocks âââââââââââââââââââââââââââââââââ
// Detects block markers: a lone number or US-prefixed number on its own line.
// Examples: "1\n", "2\n", "US01\n", "US02\n", "1-\n", "deal 1\n"
// Returns array of { position, blockNum, section } or null if no markers found.

function splitIntoProductBlocks(text) {
  // Matches a line that is ONLY a block identifier (with optional leading space):
  //   "1", "2", "US01", "1-", "deal 1", "product 1", etc.
  const markerRe = /(?:^|\n)[ \t]*(?:(?:deal|product)[ \t]*)?(\bUS\d+\b|\b\d+\b)[ \t]*-?[ \t]*\n/gi;

  const positions = [];
  let match;
  while ((match = markerRe.exec(text)) !== null) {
    // contentStart: where the block content begins (after the marker line)
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

// âââ Find all Amazon URLs in a text string ââââââââââââââââââââââââââââââââââââ

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

// âââ Add affiliate tag â always from env, never hardcoded ââââââââââââââââââââ

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

// âââ Extract ASIN from URL ââââââââââââââââââââââââââââââââââââââââââââââââââââ

function extractAsin(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

// âââ Extract product image from the HTML near a given URL ââââââââââââââââââââ
// Scans raw HTML in a window around productUrl â nextProductUrl.

function extractImageForSection(rawHtml, productUrl, nextProductUrl) {
  const start = rawHtml.indexOf(productUrl);
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

// âââ Claude extracts 7 fields from one product block âââââââââââââââââââââââââ
// Claude sees the FULL block for this product only â hard-bounded by block markers.

async function extractFromBlock(section, position, apiKey) {
  const prompt = `You are a deal extraction assistant. The text below is ONE product block (#${position}).
Extract EXACTLY these 7 fields. No guessing, no inferring â only what is explicitly written.

FIELDS:
1. productName   â The product title/name only. NEVER include a % or promo code here.
2. discountPercent â The discount percentage (e.g. "50% off", "30%"). null if not stated.
3. promoCode     â The discount/promo code (letters + numbers only, e.g. "V6WA8CIO"). null if none.
4. dealPrice     â The deal/discount price (e.g. "$19.98"). If a range, return only the first value.
5. amazonUrl     â The Amazon link (full URL starting with https://www.amazon.com/...).
6. expirationDate â The end/expiration date. Ignore start dates.
7. imageUrl      â null (images are fetched separately; always return null for this field).

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

// âââ Format into the canonical 7-field deal record âââââââââââââââââââââââââââ

function formatDeal(extracted, affiliateUrl, imageUrl, position, meta) {
  const f = extracted || {};
  // Use Claude's extracted URL if present, else fall back to the one we found
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

// âââ MAIN HANDLER âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

    // PHASE 1 â EXTRACT
    const emailText = htmlToText(rawHtml) || plainText;

    // Split by numbered block markers (1\n, 2\n, US01\n, etc.)
    // Fall back to URL-based splitting if no markers found.
    let blocks = splitIntoProductBlocks(emailText);

    // Fallback: if no numbered blocks detected, create one block per Amazon URL
    if (!blocks || blocks.length === 0) {
      const allUrls = findAmazonUrls(emailText);
      if (allUrls.length === 0) {
        return new Response(JSON.stringify({ error: 'No product blocks or Amazon URLs found in email.' }), {
          status: 400, headers: { 'Content-Type': 'application/json' },
        });
      }
      // One big block containing everything â Claude will extract what it can
      blocks = [{ position: 1, blockNum: '1', section: emailText }];
    }

    // Collect all Amazon URLs from the full email (for image extraction only)
    const allUrlsForImages = findAmazonUrls(rawHtml + '\n' + emailText);

    const deals = [];
    let totalInputTokens  = 0;
    let totalOutputTokens = 0;

    for (const block of blocks) {
      const { position, section } = block;

      // Find the Amazon URL within this block (for affiliate tag + ASIN + image)
      const blockUrls  = findAmazonUrls(section);
      const primaryUrl = blockUrls[0] || null;
      const nextUrl    = allUrlsForImages[allUrlsForImages.indexOf(primaryUrl) + 1] || null;

      const asin         = primaryUrl ? extractAsin(primaryUrl) : null;
      const affiliateUrl = primaryUrl ? addAffiliateTag(primaryUrl) : null;
      const imageUrl     = primaryUrl ? extractImageForSection(rawHtml, primaryUrl, nextUrl) : null;

      // Call Claude on the full block text
      const result = await extractFromBlock(section, position, apiKey);

      totalInputTokens  += result.tokens?.input_tokens  || 0;
      totalOutputTokens += result.tokens?.output_tokens || 0;

      // PHASE 2 â FORMAT
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
        }
      );
      deals.push(deal);
    }

    // PHASE 3 â SAVE to Netlify Blobs as 'pending'
    const store   = getStore('deals');
    const saved   = [];
    const skipped = [];

    for (const deal of deals) {
      if (!deal.productName) {
        skipped.push({ position: deal.position, reason: 'no productName extracted' });
        continue;
      }

      // Dedup key: prefer ASIN, fall back to URL hash
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
