// email-extraction-engine.mjs
// Three-phase pipeline: Extract → Format → Save to pending
//
// PHASE 1 — EXTRACT: Claude reads each product's isolated text section.
// PHASE 2 — FORMAT: Fields are placed into the canonical 7-field sequence.
// PHASE 3 — SAVE: Each deal is written to Netlify Blobs with status 'pending'
//           for human review in the admin panel before going live.
//
// Products are processed in sequence (deal 1 = product 1, deal 2 = product 2...).
// Each product is fully isolated — its text section is bounded by the Amazon URLs
// of adjacent products. Data from product N can NEVER appear in product M.
//
// NO guessing. NO inferring. NO affiliate links.
// All deals go to PENDING — nothing is auto-approved.

import { getStore } from '@netlify/blobs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_PRODUCTS = 10;

// ─── PHASE 1a: Strip HTML to readable text ───────────────────────────────────

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

// ─── PHASE 1b: Find all Amazon product URLs (preserves order = product sequence) ─

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

// ─── PHASE 1c: Extract ASIN from URL ─────────────────────────────────────────

function extractAsin(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

// ─── PHASE 1d: Extract image URL from HTML using ASIN, then proximity ────────
// Image comes from the raw HTML — ASIN match is the most reliable signal.
// Proximity fallback used only when ASIN match fails.
// Returns null if no confident match found.

function extractImageForProduct(rawHtml, asin, productUrl) {
  const cdnPatterns = [
    /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/images-na\.ssl-images-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/images\.amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/ecx\.images-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
  ];
  const allImages = [];
  for (const pat of cdnPatterns) {
    for (const img of (rawHtml.match(pat) || [])) {
      const clean = img.split('?')[0];
      if (!/_SL75_|_SS40_|thumbnail/i.test(clean)) allImages.push(clean);
    }
  }
  const unique = [...new Set(allImages)];
  if (unique.length === 0) return null;

  if (asin) {
    const match = unique.find(img => img.includes(asin));
    if (match) return match;
  }

  const urlPos = rawHtml.indexOf(productUrl);
  if (urlPos >= 0) {
    let best = null, bestDist = Infinity;
    for (const img of unique) {
      const pos = rawHtml.indexOf(img);
      if (pos >= 0) {
        const dist = Math.abs(pos - urlPos);
        if (dist < bestDist && dist < 2000) { bestDist = dist; best = img; }
      }
    }
    if (best) return best;
  }

  return null;
}

// ─── PHASE 1e: Split text into isolated per-product sections ─────────────────
// Product N's section spans from end of URL[N-1] to start of URL[N+1].
// Hard boundaries ensure data from product A cannot appear in product B's section.

function splitIntoProductSections(text, urls) {
  if (urls.length === 0) return [];
  const positions = [];
  for (const url of urls) {
    const idx = text.indexOf(url);
    if (idx >= 0) positions.push({ url, idx, end: idx + url.length });
  }
  positions.sort((a, b) => a.idx - b.idx);
  return positions.map((p, i) => {
    const start = i === 0 ? 0 : positions[i - 1].end;
    const end   = i === positions.length - 1 ? text.length : positions[i + 1].idx;
    return { url: p.url, position: i + 1, section: text.slice(start, end).trim() };
  });
}

// ─── PHASE 1f: Claude extracts raw fields from one product's section ──────────
// Claude only sees text for THIS product —"no other product's data is in scope.
// discountPercent must appear verbatim; it is never calculated.

async function extractFromSection(section, url, position, apiKey) {
  const prompt = `You are a deal extraction assistant. The text below belongs to product #${position} only.

STRICT RULES:
- Extract ONLY what is explicitly written in this text. Do NOT guess or infer.
- If a field is not clearly present in the text, return null.
- Never copy data from another product.
- Never calculate anything (no math, no price comparison).
- discountPercent must appear verbatim in the text (e.g. "50% off", "40% off"). Do not derive it.
- promoCode is a coupon/promo/discount code made of letters and numbers only. It is NOT a percentage.

Return a JSON object with EXACTLY these fields:
{
  "productName": string or null,
  "dealPrice": string or null,
  "promoCode": string or null,
  "discountPercent": string or null,
  "expirationDate": string or null
}

Return ONLY the JSON object. No explanation. No markdown. No commentary.

TEXT FOR PRODUCT #${position}:
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

// ─── PHASE 2: Format into the canonical 7-field sequence ─────────────────────
// Canonical field order:
//   1. productName  2. dealPrice  3. promoCode  4. discountPercent
//   5. amazonUrl    6. imageUrl   7. expirationDate

function formatDeal(extracted, amazonUrl, imageUrl, position, meta) {
  const f = extracted || {};
  return {
    position,
    productName:     f.productName     || null,
    dealPrice:       f.dealPrice       || null,
    promoCode:       f.promoCode       || null,
    discountPercent: f.discountPercent || null,
    amazonUrl,
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
      rawHtml   = b.htmlBody  || b.html  || '';
      plainText = b.textBody  || b.text  || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f  = await req.formData();
      rawHtml   = f.get('htmlBody')  || f.get('html')  || '';
      plainText = f.get('textBody')  || f.get('text')  || '';
    } else {
      rawHtml = await req.text();
    }

    if (!rawHtml && !plainText) {
      return new Response(JSON.stringify({ error: 'No email content received. Send htmlBody or textBody.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // PHASE 1 — EXTRACT
    const emailText     = htmlToText(rawHtml) || plainText;
    const allUrls       = findAmazonUrls(rawHtml + '\n' + plainText);
    const urlsToProcess = allUrls.slice(0, MAX_PRODUCTS);
    const sections      = splitIntoProductSections(emailText, urlsToProcess);

    const deals = [];
    let totalInputTokens  = 0;
    let totalOutputTokens = 0;

    for (const { url, section, position } of sections) {
      const asin     = extractAsin(url);
      const imageUrl = extractImageForProduct(rawHtml, asin, url);
      const result   = await extractFromSection(section, url, position, apiKey);

      totalInputTokens  += result.tokens?.input_tokens  || 0;
      totalOutputTokens += result.tokens?.output_tokens || 0;

      // PHASE 2 — FORMAT
      const deal = formatDeal(
        result.ok ? result.fields : null,
        url,
        imageUrl,
        position,
        {
          extractionOk:    result.ok,
          extractionError: result.ok ? null : result.error,
          asin,
          sectionLength:   section.length,
          sectionPreview:  section.slice(0, 300),
        }
      );
      deals.push(deal);
    }

    // PHASE 3 — SAVE: Write each formatted deal to Netlify Blobs as 'pending'.
    // Deals with no productName are skipped (nothing to review).
    const store = getStore('deals');
    const saved = [];
    const skipped = [];

    for (const deal of deals) {
      if (!deal.productName) {
        skipped.push({ position: deal.position, reason: 'no productName extracted' });
        continue;
      }

      // Dedup key: prefer ASIN, fall back to URL hash
      const asin = deal._meta.asin;
      const dedupKey = asin
        ? `asin:${asin}`
        : `url:${Buffer.from(deal.amazonUrl).toString('base64').slice(0, 20)}`;

      // Check for existing deal with same key
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
        urlsFound:   allUrls.length,
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
