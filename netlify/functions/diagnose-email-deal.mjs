// diagnose-email-deal.mjs
// READ-ONLY diagnostic endpoint.
// Accepts an email, runs extraction only, returns a structured report per product.
// NO database writes. NO affiliate links. NO Amazon page fetches. NO enrichment.
// NO normalization. NO repair. NO guessing.

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function extractAmazonUrls(text) {
  const pats = [
    /https?:\/\/(?:www\.)?amazon\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.to\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/a\.co\/[^\s"'<>)]+/gi,
    /https?:\/\/deals\.amazon\.com\/[^\s"'<>)]+/gi,
  ];
  const seen = new Set(), urls = [];
  for (const p of pats) {
    for (const u of (text.match(p) || [])) {
      const c = u.replace(/[)>\s'"]+$/, '');
      if (!seen.has(c)) { seen.add(c); urls.push(c); }
    }
  }
  return urls;
}

function extractAsinFromUrl(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

function getContext(rawHtml, url, asin) {
  const terms = [url, ...(asin ? [asin] : [])];
  const bounds = [];
  const pat = /https?:\/\/(?:www\.)?(?:amazon\.com|amzn\.to|amzn\.com|a\.co)[^\s"'<>)]+/gi;
  let m;
  while ((m = pat.exec(rawHtml)) !== null) bounds.push({ pos: m.index, end: m.index + m[0].length });

  for (const term of terms) {
    const idx = rawHtml.indexOf(term);
    if (idx >= 0) {
      const prev = bounds.filter(u => u.end <= idx).slice(-1)[0];
      const next = bounds.find(u => u.pos > idx);
      const s = prev ? prev.end : Math.max(0, idx - 3000);
      const e = next ? next.pos : Math.min(rawHtml.length, idx + term.length + 3000);
      return { stripped: stripHtml(rawHtml.slice(s, e)), boundedByPrev: !!prev, boundedByNext: !!next };
    }
  }
  const stripped = stripHtml(rawHtml);
  for (const term of terms) {
    const idx = stripped.indexOf(term);
    if (idx >= 0) return { stripped: stripped.slice(Math.max(0, idx - 600), idx + term.length + 600), boundedByPrev: false, boundedByNext: false, fallback: true };
  }
  return { stripped: '', boundedByPrev: false, boundedByNext: false, fallback: true, empty: true };
}

function tryExtractTitle(ctx, url) {
  const urlPos = url ? ctx.indexOf(url) : -1;
  const region = urlPos > 0 ? ctx.slice(0, urlPos) : ctx;
  const candidates = region
    .split(/[\n\r]+/)
    .map(l => l.replace(/[*_#>]+/g, ' ').trim())
    .filter(l =>
      l.length >= 15 && l.length <= 200 &&
      /[a-zA-Z]{4}/.test(l) &&
      !/^\$/.test(l) &&
      !/^https?:/.test(l) &&
      !/^\d+(\.\d+)?$/.test(l) &&
      !/^\d[\d.\-]*\s*\(Reg/i.test(l) &&
      !/^[\d.\-\s]+$/.test(l.replace(/Reg\.[\d.\-]*/gi,'').replace(/[()]/g,'').trim())
    )
    .map((l, i) => ({ line: i, text: l }));
  const picked = candidates[candidates.length - 1] || null;
  return { value: picked?.text || null, matched: !!picked, candidates: candidates.slice(-5) };
}

function tryExtractPrice(ctx) {
  const pats = [
    { label: 'X.XX(Reg.', re: /\b(\d{1,4}\.\d{2})(?:\s*[-]\s*\d+\.\d{2})?\s*\(Reg\./i },
    { label: 'deal/sale/now: $X', re: /(?:deal|sale|now|only|get\s+it\s+for)[:\s]+\$\s*([\d,]+\.?\d*)/i },
    { label: 'price: $X', re: /price[:\s]+\$\s*([\d,]+\.?\d*)/i },
    { label: 'standalone $X.XX', re: /(?:^|\s)\$\s*([\d,]+\.\d{2})(?!\s*(?:off|discount|save|was|original|reg|before))/m },
  ];
  for (const { label, re } of pats) {
    const m = ctx.match(re);
    if (m?.[1]) {
      const n = parseFloat(m[1].replace(/[^0-9.]/g,''));
      if (!isNaN(n) && n > 0.5 && n < 10000) return { value: m[1], matched: true, patternLabel: label };
    }
  }
  return { value: null, matched: false, patternLabel: null };
}

function tryExtractOriginalPrice(ctx) {
  const pats = [
    { label: '(Reg.X)', re: /\(Reg\.\s*(\d+\.?\d*)(?:\s*[-]\s*\d+\.?\d*)?\)/i },
    { label: 'was/reg/original: $X', re: /(?:was|original|reg(?:ular)?|list|retail|msrp|normally|before)[:\s]*\$\s*([\d,]+\.?\d*)/i },
  ];
  for (const { label, re } of pats) {
    const m = ctx.match(re);
    if (m?.[1]) return { value: m[1], matched: true, patternLabel: label };
  }
  return { value: null, matched: false, patternLabel: null };
}

function tryExtractPromoCode(ctx) {
  const STOP = new Set(['GET','USE','THE','FOR','AND','WITH','OFF','CODE','PROMO','DISCOUNT','COUPON','DEAL','SALE','SAVE','CLIP','CHECK','VIEW','MORE','SHOP','FREE','FAST','BEST','CLICK','HERE','LINK','ITEM','OFFER','PRICE','AMAZON','CHECKOUT']);
  const pats = [
    { label: 'code/coupon/promo: CODE', re: /(?:code|coupon|promo|discount|voucher)[:\s=]+\[?([A-Z0-9]{4,20})\]?/i },
    { label: 'apply code CODE at', re: /apply\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?\s+at/i },
    { label: 'use code CODE', re: /use\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?(?:\s|$)/i },
    { label: 'enter code CODE', re: /enter\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']/i },
  ];
  for (const { label, re } of pats) {
    const m = ctx.match(re);
    if (m?.[1] && !STOP.has(m[1].toUpperCase())) return { value: m[1].toUpperCase(), matched: true, patternLabel: label };
  }
  return { value: null, matched: false, patternLabel: null };
}

function tryExtractExpiration(ctx) {
  const pats = [
    { label: 'expires/ends: DATE', re: /(?:expires?|valid\s+(?:through|until|thru)|ends?|offer\s+ends?)\s*:?\s*([A-Za-z]+\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i },
    { label: 'month day year', re: /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?)\b/i },
    { label: 'MM/DD/YYYY', re: /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/ },
  ];
  for (const { label, re } of pats) {
    const m = ctx.match(re);
    if (m?.[1]) {
      const d = new Date(m[1]);
      const ok = !isNaN(d.getTime()) && d.getFullYear() >= new Date().getFullYear();
      return { value: m[1], matched: true, parsedDate: ok ? d.toISOString() : null, parseable: ok, patternLabel: label };
    }
  }
  return { value: null, matched: false, patternLabel: null };
}

function tryExtractImage(rawHtml, asin, url) {
  const imgPats = [
    /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/images-na\.ssl-images-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
  ];
  const all = [];
  for (const p of imgPats) for (const img of (rawHtml.match(p) || [])) { const c = img.split('?')[0]; if (!/_SL75_|_SS40_|thumbnail/i.test(c)) all.push(c); }
  const uniq = [...new Set(all)];
  if (asin) { const a = uniq.find(i => i.includes(asin)); if (a) return { value: a, matched: true, method: 'asin-match' }; }
  const urlPos = rawHtml.indexOf(url);
  if (urlPos >= 0) {
    let best = null, bestDist = Infinity;
    for (const img of uniq) { const pos = rawHtml.indexOf(img); if (pos >= 0) { const d = Math.abs(pos - urlPos); if (d < bestDist && d < 3000) { bestDist = d; best = img; } } }
    if (best) return { value: best, matched: true, method: 'proximity', distChars: bestDist };
  }
  return { value: null, matched: false, method: null, totalImagesInEmail: uniq.length };
}

export default async (req) => {
  try {
    let rawHtml = '', plainText = '';
    const ct = req.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const b = await req.json();
      rawHtml = b.htmlBody || b.html || ''; plainText = b.textBody || b.text || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f = await req.formData();
      rawHtml = f.get('htmlBody') || f.get('html') || ''; plainText = f.get('textBody') || f.get('text') || '';
    } else { rawHtml = await req.text(); }

    if (!rawHtml && !plainText) return new Response(JSON.stringify({ error: 'No email content' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const allUrls = extractAmazonUrls(rawHtml + '\n' + plainText);
    const report = {
      summary: { htmlLength: rawHtml.length, plainLength: plainText.length, urlsFound: allUrls.length, urlsProcessed: Math.min(allUrls.length, 10) },
      urls: allUrls,
      products: [],
    };

    for (let i = 0; i < Math.min(allUrls.length, 10); i++) {
      const url = allUrls[i];
      const asin = extractAsinFromUrl(url);
      const ctx = getContext(rawHtml, url, asin);
      report.products.push({
        index: i + 1, amazonUrl: url, asin,
        context: { length: ctx.stripped.length, boundedByPrev: ctx.boundedByPrev, boundedByNext: ctx.boundedByNext, fallback: ctx.fallback || false, empty: ctx.empty || false, text: ctx.stripped.slice(0, 800) },
        extracted: {
          title:         tryExtractTitle(ctx.stripped, url),
          price:         tryExtractPrice(ctx.stripped),
          originalPrice: tryExtractOriginalPrice(ctx.stripped),
          promoCode:     tryExtractPromoCode(ctx.stripped),
          expiresOn:     tryExtractExpiration(ctx.stripped),
          image:         tryExtractImage(rawHtml, asin, url),
        },
      });
    }
    return new Response(JSON.stringify(report, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/diagnose-email-deal' };
