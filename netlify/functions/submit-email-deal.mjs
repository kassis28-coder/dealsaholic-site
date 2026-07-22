import { getStore } from "@netlify/blobs";

const AFFILIATE_TAG = process.env.AMAZON_PARTNER_TAG || 'daholic-20';

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// HTML / TEXT UTILITIES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function extractCdnImages(html) {
  const patterns = [
    /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/images-na\.ssl-images-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/images\.amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/[a-z0-9-]+\.ssl-images-amazon\.com\/images\/[A-Za-z0-9%._/-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/ecx\.images-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
  ];
  const seen = new Set();
  const images = [];
  for (const pat of patterns) {
    for (const url of (html.match(pat) || [])) {
      const clean = url.split('?')[0];
      if (!seen.has(clean) && !/_SL75_|_SS40_|thumbnail/i.test(clean)) {
        seen.add(clean);
        images.push(clean);
      }
    }
  }
  return images;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// AMAZON URL / ASIN UTILITIES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function extractAmazonUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.to\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/a\.co\/[^\s"'<>)]+/gi,
    /https?:\/\/deals\.amazon\.com\/[^\s"'<>)]+/gi,
  ];
  const seen = new Set();
  const urls = [];
  for (const pat of patterns) {
    for (const url of (text.match(pat) || [])) {
      const clean = url.replace(/[)>\s'"]+$/, '');
      if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
    }
  }
  return urls;
}

function parseDollar(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function buildAffiliateUrl(asin, rawUrl) {
  if (asin) return `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('tag', AFFILIATE_TAG);
    return u.toString();
  } catch {
    return rawUrl + (rawUrl.includes('?') ? '&' : '?') + `tag=${AFFILIATE_TAG}`;
  }
}

async function resolveAsin(url) {
  const direct = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  if (direct) return direct;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) });
    return (r.url || url).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
  } catch { return null; }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PER-PRODUCT CONTEXT WINDOW (+-600 chars around each URL)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function getProductContext(rawHtml, plainText, url, asin) {
  const terms = [url, ...(asin ? [asin] : [])];

  // Map all Amazon URL positions in raw HTML to use as product boundaries
  const urlBoundaries = [];
  const urlPat = /https?:\/\/(?:www\.)?(?:amazon\.com|amzn\.to|amzn\.com|a\.co)[^\s"'<>)]+/gi;
  let m;
  while ((m = urlPat.exec(rawHtml)) !== null) urlBoundaries.push({ pos: m.index, end: m.index + m[0].length });

  for (const term of terms) {
    const idx = rawHtml.indexOf(term);
    if (idx >= 0) {
      // Bound the context between the prev and next Amazon URL
      const prev = urlBoundaries.filter(u => u.end <= idx).slice(-1)[0];
      const next = urlBoundaries.find(u => u.pos > idx);
      const rawStart = prev ? prev.end : Math.max(0, idx - 3000);
      const rawEnd   = next ? next.pos : Math.min(rawHtml.length, idx + term.length + 3000);
      return stripHtml(rawHtml.slice(rawStart, rawEnd));
    }
  }

  // Fallback: stripped HTML or plain text
  const stripped = stripHtml(rawHtml);
  const W = 600;
  for (const src of [stripped, plainText || '']) {
    for (const term of terms) {
      const idx = src.indexOf(term);
      if (idx >= 0) return src.slice(Math.max(0, idx - W), idx + term.length + W);
    }
  }
  return '';
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// FIELD EXTRACTORS
// Each receives only THIS product's context window.
// If a field is not found, return null.
// Never read from the full email or another product's context.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function extractTitle(context, url) {
  const urlPos = url ? context.indexOf(url) : -1;
  const region = urlPos > 0 ? context.slice(0, urlPos) : context;
  const lines = region
    .split(/[\n\r]+/)
    .map(l => l.replace(/[*_#>]+/g, ' ').trim())
    .filter(l =>
      l.length >= 15 && l.length <= 200 &&
      /[a-zA-Z]{4}/.test(l) &&
      !/^\$/.test(l) &&
      !/^https?:/.test(l) &&
      !/^\d+(\.\d+)?$/.test(l) &&
      !/^\d[\d.\-]*\s*\(Reg/i.test(l) &&
      !/^[\d.\-\s]+$/.test(l.replace(/Reg\.\d[\d.\-]*/gi,'').replace(/[()]/g,'').trim())
    );
  return lines[lines.length - 1] || null;
}

function extractPrice(context) {
  const patterns = [
    /\b(\d{1,4}\.\d{2})(?:\s*[-]\s*\d+\.\d{2})?\s*\(Reg\./i,
    /(?:deal|sale|now|only|get\s+it\s+for)[:\s]+\$\s*([\d,]+\.?\d*)/i,
    /price[:\s]+\$\s*([\d,]+\.?\d*)/i,
    /(?:^|\s)\$\s*([\d,]+\.\d{2})(?!\s*(?:off|discount|save|was|original|reg|before))/m,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1]) {
      const val = parseDollar(m[1]);
      if (val && val > 0.5 && val < 10000) return `$${val.toFixed(2)}`;
    }
  }
  return null;
}

function extractOriginalPrice(context) {
  const patterns = [
    /\(Reg\.\s*(\d+\.?\d*)(?:\s*[-]\s*\d+\.?\d*)?\)/i,
    /(?:was|original|reg(?:ular)?|list|retail|msrp|normally|before)[:\s]*\$\s*([\d,]+\.?\d*)/i,
    /\$\s*([\d,]+\.\d{2})\s*(?:->|before)/i,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1]) {
      const val = parseDollar(m[1]);
      if (val && val > 0.5 && val < 10000) return `$${val.toFixed(2)}`;
    }
  }
  return null;
}

function extractPromoCode(context) {
  // STRICT: only this product's context window â never the full email.
  const STOP = new Set([
    'GET', 'USE', 'THE', 'FOR', 'AND', 'WITH', 'OFF', 'CODE', 'PROMO',
    'DISCOUNT', 'COUPON', 'DEAL', 'SALE', 'SAVE', 'CLIP', 'CHECK', 'VIEW',
    'MORE', 'SHOP', 'FREE', 'FAST', 'BEST', 'CLICK', 'HERE', 'LINK',
    'ITEM', 'OFFER', 'PRICE', 'AMAZON', 'CHECKOUT',
  ]);
  const patterns = [
    /(?:code|coupon|promo|discount|voucher)[:\s=]+\[?([A-Z0-9]{4,20})\]?/i,
    /apply\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?\s+at/i,
    /use\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?(?:\s|$)/i,
    /enter\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']/i,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1] && !STOP.has(m[1].toUpperCase())) return m[1].toUpperCase();
  }
  return null;
}

function extractExpirationDate(context) {
  const patterns = [
    /(?:expires?|valid\s+(?:through|until|thru)|ends?|offer\s+ends?)\s*:?\s*([A-Za-z]+\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i,
    /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?)\b/i,
    /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1]) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime()) && d.getFullYear() >= new Date().getFullYear()) return d.toISOString();
    }
  }
  return null;
}

function extractImageForProduct(rawHtml, cdnImages, asin, url) {
  if (!cdnImages.length) return null;
  // 1. ASIN match (most reliable)
  if (asin) {
    const match = cdnImages.find(img => img.includes(asin));
    if (match) return match;
  }
  // 2. Proximity: image closest to this URL in raw HTML (within 3000 chars)
  const urlPos = rawHtml.indexOf(url);
  if (urlPos >= 0) {
    let best = null, bestDist = Infinity;
    for (const img of cdnImages) {
      const pos = rawHtml.indexOf(img);
      if (pos >= 0) {
        const dist = Math.abs(pos - urlPos);
        if (dist < bestDist && dist < 3000) { bestDist = dist; best = img; }
      }
    }
    if (best) return best;
  }
  // 3. No match â return null, never borrow from another product
  return null;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// AMAZON META FETCH (fallback for missing title / image / price)
// Only called after extraction if those fields are still null.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function fetchAmazonMeta(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return {};
    const html = await r.text();
    const title = html.match(/<span[^>]*id="productTitle"[^>]*>\s*([^<]+?)\s*<\/span>/i)?.[1]?.trim() || null;
    const image =
      html.match(/"hiRes"\s*:\s*"(https:[^"]+)"/)?.[1] ||
      html.match(/"large"\s*:\s*"(https:[^"]+)"/)?.[1] ||
      html.match(/id="landingImage"[^>]*data-old-hires="([^"]+)"/i)?.[1] ||
      null;
    const pw = html.match(/class="a-price-whole"[^>]*>(\d+)<\/span>/)?.[1];
    const pf = html.match(/class="a-price-fraction"[^>]*>(\d+)<\/span>/)?.[1];
    const price = pw ? parseDollar(`${pw}.${pf || '00'}`) : null;
    const origM = html.match(/class="a-text-price"[^>]*><span[^>]*>\$\s*([\d,.]+)<\/span>/);
    const originalPrice = origM ? parseDollar(origM[1]) : null;
    return {
      title,
      image,
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: originalPrice ? `$${originalPrice.toFixed(2)}` : null,
    };
  } catch { return {}; }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PHASE 1 â Extract all product drafts (no DB writes)
// Each draft contains only what was found in that product's context.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function extractAllProducts(rawHtml, plainText, emailText) {
  const cdnImages = extractCdnImages(rawHtml);
  const combined = rawHtml + '\n' + (plainText || '') + '\n' + (emailText || '');
  const allUrls = extractAmazonUrls(combined);
  const urlsToProcess = allUrls.slice(0, 5);

  console.log(`[Phase 1] URLs found: ${allUrls.length}, processing: ${urlsToProcess.length}, CDN images: ${cdnImages.length}`);

  const drafts = [];
  for (let i = 0; i < urlsToProcess.length; i++) {
    const url = urlsToProcess[i];
    const asin = await resolveAsin(url);
    const context = getProductContext(rawHtml, plainText || emailText || '', url, asin);

    const draft = {
      amazonUrl:      url,
      asin:           asin || null,
      productName:    extractTitle(context, url)                          || null,
      dealPrice:      extractPrice(context)                               || null,
      originalPrice:  extractOriginalPrice(context)                      || null,
      discountCode:   extractPromoCode(context)                          || null,
      expirationDate: extractExpirationDate(context)                     || null,
      imageUrl:       extractImageForProduct(rawHtml, cdnImages, asin, url) || null,
    };

    console.log(`[Phase 1] Product ${i + 1}/${urlsToProcess.length}:`, JSON.stringify({
      url:            url.slice(0, 60),
      asin:           draft.asin,
      productName:    draft.productName,
      dealPrice:      draft.dealPrice,
      originalPrice:  draft.originalPrice,
      discountCode:   draft.discountCode,
      expirationDate: draft.expirationDate,
      imageUrl:       draft.imageUrl ? '[found]' : null,
      contextLen:     context.length,
    }));

    drafts.push(draft);
  }

  return { drafts, urlsFound: allUrls.length };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PHASE 2 â Validate each draft independently
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function validateDraft(draft, i) {
  const issues = [];
  if (!draft.amazonUrl) issues.push('no Amazon URL');
  if (!draft.asin && !/\/dp\/|\/gp\/product\/|\/promocode\//i.test(draft.amazonUrl || '')) {
  issues.push('could not resolve ASIN and URL is not a direct product link');
}
  if (issues.length === 0) {
    if (!draft.productName)   console.log(`[Phase 2] Product ${i + 1}: no title in context â will try Amazon page`);
    if (!draft.dealPrice)     console.log(`[Phase 2] Product ${i + 1}: no price in context â will try Amazon page`);
    if (!draft.imageUrl)      console.log(`[Phase 2] Product ${i + 1}: no image in email â will try Amazon page`);
  }
  return { valid: issues.length === 0, issues };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PHASE 3 â Save each validated draft (with Amazon enrichment)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function saveDraft(draft, store, indexArr, ids, deals) {
  const affiliateUrl = buildAffiliateUrl(draft.asin, draft.amazonUrl);
  let { productName: title, dealPrice, originalPrice, imageUrl } = draft;

  if (!title || !imageUrl || !dealPrice) {
    const meta = await fetchAmazonMeta(affiliateUrl);
    title         = title         || meta.title         || null;
    imageUrl      = imageUrl      || meta.image         || null;
    dealPrice     = dealPrice     || meta.price         || null;
    originalPrice = originalPrice || meta.originalPrice || null;
  }

  const priceNum        = parseDollar(dealPrice);
  const origNum         = parseDollar(originalPrice);
  const discountPercent = (priceNum && origNum && origNum > priceNum)
    ? Math.round((1 - priceNum / origNum) * 100) : null;

  const expiresOn = draft.expirationDate || (() => {
    const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString();
  })();

  const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    productTitle:   title || '',
    productUrl:     affiliateUrl,
    asin:           draft.asin || null,
    price:          dealPrice || '',
    originalPrice:  originalPrice || null,
    discountPercent,
    discountCode:   draft.discountCode || null,
    image:          imageUrl || null,
    expiresOn,
    status:         'pending',
    source:         'email',
    createdAt:      new Date().toISOString(),
    submittedAt:    new Date().toISOString(),
  };

  await store.set(id, JSON.stringify(record));
  indexArr.unshift(id);
  ids.push(id);
  deals.push({ id, title: record.productTitle, price: record.price, url: affiliateUrl, imageUrl: record.image, discountCode: record.discountCode });

  console.log(`[Phase 3] Saved ${id}: "${record.productTitle}" ${record.price} code=${record.discountCode}`);
  return record;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// MAIN HANDLER
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export default async (req) => {
  try {
    let rawHtml = '', plainText = '', emailText = '';
    const ct = req.headers.get('content-type') || '';

    if (ct.includes('application/json')) {
      const b = await req.json();
      rawHtml = b.htmlBody || b.html || ''; plainText = b.textBody || b.text || ''; emailText = b.emailText || b.email || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f = await req.formData();
      rawHtml = f.get('htmlBody') || f.get('html') || ''; plainText = f.get('textBody') || f.get('text') || ''; emailText = f.get('emailText') || f.get('email') || '';
    } else {
      const t = await req.text(); rawHtml = t; emailText = t;
    }

    if (!rawHtml && !plainText && !emailText) {
      return new Response(JSON.stringify({ success: false, error: 'No email content received' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ââ PHASE 1: Extract âââââââââââââââââââââââââââââââââââ
    const { drafts, urlsFound } = await extractAllProducts(rawHtml, plainText, emailText);
    console.log(`[Phase 1] Complete: ${drafts.length} drafts from ${urlsFound} URLs`);

    // ââ PHASE 2: Validate ââââââââââââââââââââââââââââââââââ
    const validDrafts = [];
    for (let i = 0; i < drafts.length; i++) {
      const { valid, issues } = validateDraft(drafts[i], i);
      if (valid) validDrafts.push(drafts[i]);
      else console.warn(`[Phase 2] Product ${i + 1} rejected:`, issues.join('; '));
    }
    console.log(`[Phase 2] Complete: ${validDrafts.length}/${drafts.length} valid`);

    if (validDrafts.length === 0) {
      return new Response(JSON.stringify({
        success: false, error: 'No valid Amazon products found in email',
        amazonUrlsFound: urlsFound, draftsExtracted: drafts.length,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ââ PHASE 3: Save ââââââââââââââââââââââââââââââââââââââ
    const store = getStore('submissions');
    let indexArr = [];
    try {
      const existing = await store.get('index', { type: 'json' });
      if (Array.isArray(existing)) indexArr = existing;
    } catch { /* no index yet */ }

    const ids = [], deals = [], savedRecords = [];
    for (const draft of validDrafts) {
      try {
        savedRecords.push(await saveDraft(draft, store, indexArr, ids, deals));
      } catch (err) {
        console.error(`[Phase 3] Failed to save ${draft.amazonUrl}:`, err.message);
      }
    }

    if (savedRecords.length > 0) await store.set('index', JSON.stringify(indexArr));
    console.log(`[Phase 3] Complete: ${savedRecords.length} records saved`);

    const first = savedRecords[0];
    const telegramMessage = first
      ? `*${first.productTitle || 'Deal'}*\n${first.price || ''}${first.discountCode ? `\nCode: ${first.discountCode}` : ''}\n${first.productUrl}`
      : null;
    const facebookMessage = first
      ? `${first.productTitle || 'Deal'}${first.price ? ` - ${first.price}` : ''}${first.discountCode ? ` | Code: ${first.discountCode}` : ''}\n${first.productUrl}`
      : null;

    return new Response(JSON.stringify({
      success: true, count: savedRecords.length, ids, deals, amazonUrlsFound: urlsFound,
      telegramMessage, facebookMessage,
      title: first?.productTitle || null, price: first?.price || null,
      originalPrice: first?.originalPrice || null, url: first?.productUrl || null, imageUrl: first?.image || null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[submit-email-deal] Fatal:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/submit-email-deal' };
