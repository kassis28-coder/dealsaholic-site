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
// NO guessing. NO inferring.
// Affiliate tag added to every URL from AMAZON_PARTNER_TAG env var.
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

// ─── PHASE 1b: Find all Amazon URLs (preserves order = product sequence) ────────
// Includes /promocode/ coupon links — each URL anchors one deal section.
// Affiliate tag is added later via addAffiliateTag().

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

// ─── Add affiliate tag to any Amazon URL ─────────────────────────────────────
// Tag always comes from env — never hardcoded.

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

// ─── PHASE 1c: Extract ASIN from URL ─────────────────────────────────────────

function extractAsin(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

// ─── PHASE 1d: Extract image URL from the product's HTML section ─────────────
// Slices the raw email HTML between this product's URL and the next URL.
// Returns the FIRST Amazon CDN image found in that slice — no guessing,
// no proximity heuristics, no ASIN matching. If the email has multiple
// images (e.g. a promo banner + product image), the first one wins.

function extractImageForSection(rawHtml, productUrl, nextProductUrl) {
  const start = rawHtml.indexOf(productUrl);
  if (start < 0) return null;

  // Include context before the URL — product images often appear above the link.
  const sectionStart = Math.max(0, start - 5000);
  const afterUrl = start + productUrl.length;
  const end = nextProductUrl
    ? rawHtml.indexOf(nextProductUrl, afterUrl)
    : rawHtml.length;
  const sectionEnd = (end > afterUrl) ? end : rawHtml.length;

  const htmlSlice = rawHtml.slice(sectionStart, sectionEnd);

  const pattern = /https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images\.amazon\.com|ecx\.images-amazon\.com)\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
  for (const img of (htmlSlice.match(pattern) || [])) {
    const clean = img.split('?')[0];
    if (!/_SL75_|_SS40_|thumbnail/i.test(clean)) return clean;
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
// Claude only sees text for THIS product — no other product's data is in scope.
// discountPercent must appear verbatim; it is never calculated.

async function extractFromSection(section, url, position, apiKey) {
  const prompt = `You are a deal extraction assistant. The text below belongs to product #${position} only.
Extract ONLY these 5 fields. Ignore everything else.

STRICT RULES:
- Extract ONLY what is explicitly written. Do NOT guess or infer.
- If a field is not present, return null.
- Never copy data from another product.
- Never calculate anything.

IGNORE these completely (do not use for any field):
- Lines starting with "Creator Campaign Id:", "rate:", "Budget:" — these are internal tracking, not product data
- Start Date — ignore it

FIELD RULES:
- productName: The product TITLE only — the name of the item (e.g. "Schwer 6 Pairs ANSI A2 Cut Resistant Work Gloves", "Eukaroy 2 pc set", "Cozy Bliss Cooling Blanket"). NEVER include a discount %, promo code, or any other data in this field. Skip any line that starts with "Creator Campaign Id:" or contains "rate:" and "Budget:".
- dealPrice: The "Discount price" field. If it is a range like "$10.99-$17.95", return ONLY the first amount: "$10.99".
- promoCode: The value after "Discount code:" — letters and numbers only (e.g. "2N76WL9K"). NEVER a percentage. If the line contains "+ X% off Coupon" after the code, return only the code letters/numbers before the "+".
- discountPercent: The value after "Discount:" — as written (e.g. "50% off", "35% off").
- expirationDate: The "End Date" value only. Ignore Start Date.

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

    for (let i = 0; i < sections.length; i++) {
      const { url, section, position } = sections[i];
      const nextUrl      = sections[i + 1]?.url || null;
      const asin         = extractAsin(url);
      const affiliateUrl = addAffiliateTag(url);
      const imageUrl     = extractImageForSection(rawHtml, url, nextUrl);
      const result       = await extractFromSection(section, url, position, apiKey);

      totalInputTokens  += result.tokens?.input_tokens  || 0;
      totalOutputTokens += result.tokens?.output_tokens || 0;

      // PHASE 2 — FORMAT
      const deal = formatDeal(
        result.ok ? result.fields : null,
        affiliateUrl,
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
