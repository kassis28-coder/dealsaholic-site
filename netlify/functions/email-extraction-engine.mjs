// email-extraction-engine.mjs
// Three-phase pipeline: Extract â Format â Save to pending
//
// PHASE 1 â EXTRACT: Email is split into numbered product blocks (1, 2, US01â¦).
// PHASE 2 â FORMAT: Fields placed into the canonical 7-field sequence.
// PHASE 3 â SAVE: Each deal written to Netlify Blobs (submissions store) with
//           status 'pending' for human review in the admin panel.
//
// FIX: Now saves to 'submissions' store + updates index array,
//      so deals appear in admin panel Pending tab and Email Deals tab.
//
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

async function extractFromBlock(section, position, apiKey) {
  const prompt = `You are a deal extraction assistant. The text below is ONE product block (#${position}).
Extract EXACTLY these 7 fields. No guessing, no inferring â only what is explicitly written.

FIELDS:
1. productName   â The product title/name only. NEVER include a % or promo code here.
2. discountPercent â The discount percentage (e.g. "50% off", "30%"). null if not stated.
3. promoCode     â The discount/promo code (letters + numbers only). null if none.
4. dealPrice     â The deal/discount price (e.g. "$19.98"). If a range, return only the first value.
5. amazonUrl     â The Amazon link (full URL starting with https://www.amazon.com/...).
6. expirationDate â The end/expiration date. Ignore start dates.
7. imageUrl      â null (always return null for this field).

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

    // PHASE 1 â EXTRACT
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
      const imageUrl     = primaryUrl ? extractImageForSection(rawHtml, primaryUrl, nextUrl) : null;

      const result = await extractFromBlock(section, position, apiKey);
      totalInputTokens  += result.tokens?.input_tokens  || 0;
      totalOutputTokens += result.tokens?.output_tokens || 0;

      // PHASE 2 â FORMAT
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

    // PHASE 3 â SAVE to submissions store (same store the admin panel reads)
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

      // Parse expiresOn â default 7 days from now
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
