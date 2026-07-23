// email-extraction-engine.mjs
// Pure regex extraction — NO Claude API, NO external calls, NO cost.
// Handles 600+ deals per email instantly inside Netlify.
//
// Pipeline: Parse email HTML → extract deals via regex → dedup → save as 'pending'

import { getStore } from '@netlify/blobs';

// ─── HTML → plain text ────────────────────────────────────────────────────────

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Find all Amazon URLs ─────────────────────────────────────────────────────

function findAmazonUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.to\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/a\.co\/[^\s"'<>)]+/gi,
    /https?:\/\/deals\.amazon\.com\/[^\s"'<>)]+/gi,
  ];
  const seen = new Set(), urls = [];
  for (const p of patterns) {
    for (const u of (text.match(p) || [])) {
      const clean = u.replace(/[)>\s'"]+$/, '');
      if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
    }
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
  } catch { return url; }
}

// ─── Extract ASIN ─────────────────────────────────────────────────────────────

function extractAsin(url) {
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
}

// ─── Get text context around a URL ───────────────────────────────────────────

function getContext(rawHtml, url, asin, allUrls) {
  const urlPositions = allUrls.map(u => rawHtml.indexOf(u)).filter(p => p >= 0).sort((a,b) => a-b);
  const idx = rawHtml.indexOf(url);
  if (idx >= 0) {
    const prevEnd  = urlPositions.filter(p => p < idx).slice(-1)[0] ?? Math.max(0, idx - 4000);
    const nextStart = urlPositions.find(p => p > idx + url.length) ?? Math.min(rawHtml.length, idx + url.length + 4000);
    return stripHtml(rawHtml.slice(prevEnd, nextStart));
  }
  // fallback: search plain stripped text
  const stripped = stripHtml(rawHtml);
  const terms = [url, ...(asin ? [asin] : [])];
  for (const term of terms) {
    const ti = stripped.indexOf(term);
    if (ti >= 0) return stripped.slice(Math.max(0, ti - 800), ti + term.length + 800);
  }
  return '';
}

// ─── Extract title ────────────────────────────────────────────────────────────

function extractTitle(ctx, url) {
  const urlPos = ctx.indexOf(url);
  const region = urlPos > 0 ? ctx.slice(0, urlPos) : ctx;
  const candidates = region
    .split(/[\n\r]+/)
    .map(l => l.replace(/[*_#>|]+/g, ' ').trim())
    .filter(l =>
      l.length >= 15 && l.length <= 250 &&
      /[a-zA-Z]{4}/.test(l) &&
      !/^\$/.test(l) &&
      !/^https?:/.test(l) &&
      !/^\d+(\.\d+)?$/.test(l) &&
      !/^[\d.\-\s%]+$/.test(l) &&
      !/^(deal|promo|code|off|save|discount|coupon|sale|click|shop|buy|get|use|apply|enter|limited|time|today|daily|weekly)$/i.test(l)
    );
  return candidates[candidates.length - 1] || null;
}

// ─── Extract deal price ───────────────────────────────────────────────────────

function extractPrice(ctx) {
  const pats = [
    /\b(\d{1,4}\.\d{2})\s*\(Reg\./i,
    /(?:deal|sale|now|only|get\s+it\s+for|discounted\s+to)[:\s]+\$\s*([\d,]+\.?\d*)/i,
    /(?:price|for\s+only)[:\s]+\$\s*([\d,]+\.?\d*)/i,
    /(?:^|\s)\$\s*([\d,]+\.\d{2})(?!\s*(?:off|discount|save|was|original|reg|before))/m,
  ];
  for (const re of pats) {
    const m = ctx.match(re);
    if (m?.[1]) {
      const n = parseFloat(m[1].replace(/[^0-9.]/g, ''));
      if (!isNaN(n) && n > 0.5 && n < 10000) return '$' + n.toFixed(2);
    }
  }
  return null;
}

// ─── Extract promo code ───────────────────────────────────────────────────────

function extractPromoCode(ctx) {
  const STOP = new Set(['GET','USE','THE','FOR','AND','WITH','OFF','CODE','PROMO','DISCOUNT',
    'COUPON','DEAL','SALE','SAVE','CLIP','CHECK','VIEW','MORE','SHOP','FREE','FAST','BEST',
    'CLICK','HERE','LINK','ITEM','OFFER','PRICE','AMAZON','CHECKOUT','APPLY','ENTER']);
  const pats = [
    /(?:code|coupon|promo|discount|voucher)[:\s=]+\[?([A-Z0-9]{4,20})\]?/i,
    /apply\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?\s+at/i,
    /use\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?(?:\s|$)/i,
    /enter\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']/i,
    /["']([A-Z0-9]{6,15})["']\s+(?:at\s+checkout|to\s+save|for\s+\d)/i,
  ];
  for (const re of pats) {
    const m = ctx.match(re);
    if (m?.[1] && !STOP.has(m[1].toUpperCase())) return m[1].toUpperCase();
  }
  return null;
}

// ─── Extract discount percent ─────────────────────────────────────────────────

function extractDiscount(ctx) {
  const m = ctx.match(/(\d{1,2})\s*%\s*off/i);
  return m ? m[1] + '% off' : null;
}

// ─── Extract expiration date ──────────────────────────────────────────────────

function extractExpiration(ctx) {
  const pats = [
    /(?:expires?|valid\s+(?:through|until|thru)|ends?|offer\s+ends?)\s*:?\s*([A-Za-z]+\.?\s+\d{1,2}(?:,?\s*\d{4})?)/i,
    /(?:expires?|valid\s+(?:through|until|thru)|ends?)\s*:?\s*(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i,
  ];
  for (const re of pats) {
    const m = ctx.match(re);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

// ─── Extract image ────────────────────────────────────────────────────────────

function extractImage(rawHtml, asin, url) {
  // Strategy 1: Amazon CDN images near the product URL
  const amazonPat = /https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images\.amazon\.com|ecx\.images-amazon\.com)\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
  const allImgs = [...new Set((rawHtml.match(amazonPat) || []).map(i => i.split('?')[0]).filter(i => !/_SL75_|_SS40_|thumbnail/i.test(i)))];

  // Prefer image containing the ASIN
  if (asin) {
    const match = allImgs.find(i => i.includes(asin));
    if (match) return match;
  }

  // Pick the image closest to the product URL in the HTML
  const urlPos = rawHtml.indexOf(url);
  if (urlPos >= 0) {
    let best = null, bestDist = Infinity;
    for (const img of allImgs) {
      const pos = rawHtml.indexOf(img);
      if (pos >= 0) {
        const d = Math.abs(pos - urlPos);
        if (d < bestDist && d < 5000) { bestDist = d; best = img; }
      }
    }
    if (best) return best;
  }

  // Strategy 2: any <img src> tag near the URL
  const urlIdx = rawHtml.indexOf(url);
  if (urlIdx >= 0) {
    const slice = rawHtml.slice(Math.max(0, urlIdx - 3000), urlIdx + url.length + 3000);
    const imgPat = /<img[^>]+src=["']([^"']+)["']/gi;
    let m;
    while ((m = imgPat.exec(slice)) !== null) {
      const src = m[1];
      if (src.startsWith('http') && /\.(jpg|jpeg|png|webp)/i.test(src) &&
          !/_SL75_|_SS40_|thumbnail|spacer|pixel|tracking|1x1/i.test(src)) {
        return src.split('?')[0];
      }
    }
  }

  return null;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async (req) => {
  try {
    let rawHtml = '', plainText = '';
    const ct = req.headers.get('content-type') || '';

    if (ct.includes('application/json')) {
      const b = await req.json();
      rawHtml   = b.htmlBody || b.html || '';
      plainText = b.textBody || b.text || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f = await req.formData();
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

    const combined = rawHtml + '\n' + plainText;
    const allUrls  = findAmazonUrls(combined);

    if (allUrls.length === 0) {
      return new Response(JSON.stringify({ error: 'No Amazon URLs found in email.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Extract deal data for every URL in parallel (pure regex — no API calls)
    const deals = await Promise.all(
      allUrls.map(async (url, i) => {
        const asin         = extractAsin(url);
        const affiliateUrl = addAffiliateTag(url);
        const ctx          = getContext(rawHtml, url, asin, allUrls);

        return {
          position:        i + 1,
          amazonUrl:       affiliateUrl,
          asin:            asin || null,
          title:           extractTitle(ctx, url),
          price:           extractPrice(ctx),
          promoCode:       extractPromoCode(ctx),
          discountPercent: extractDiscount(ctx),
          expirationDate:  extractExpiration(ctx),
          image:           extractImage(rawHtml, asin, url),
        };
      })
    );

    // Save to Netlify Blobs with dedup
    const store   = getStore('deals');
    const saved   = [];
    const skipped = [];

    // Parallel dedup check
    const dedupResults = await Promise.all(
      deals.map(async (deal) => {
        if (!deal.title) return { deal, skip: true, reason: 'no title extracted' };

        const dedupKey = deal.asin
          ? `asin:${deal.asin}`
          : `url:${Buffer.from(deal.amazonUrl).toString('base64').slice(0, 20)}`;

        const existing = await store.get(dedupKey, { type: 'json' }).catch(() => null);
        if (existing) return { deal, skip: true, reason: 'duplicate', key: dedupKey };

        return { deal, skip: false, dedupKey };
      })
    );

    // Sequential save
    for (const { deal, skip, reason, dedupKey } of dedupResults) {
      if (skip) {
        skipped.push({ position: deal.position, reason });
        continue;
      }

      const record = {
        title:           deal.title,
        price:           deal.price,
        promoCode:       deal.promoCode,
        discountPercent: deal.discountPercent,
        url:             deal.amazonUrl,
        image:           deal.image,
        expirationDate:  deal.expirationDate,
        asin:            deal.asin,
        status:          'pending',
        source:          'email',
        createdAt:       new Date().toISOString(),
        emailPosition:   deal.position,
      };

      await store.set(dedupKey, JSON.stringify(record));
      saved.push({ position: deal.position, key: dedupKey, title: deal.title });
    }

    return new Response(JSON.stringify({
      summary: {
        urlsFound: allUrls.length,
        extracted: deals.length,
        saved:     saved.length,
        skipped:   skipped.length,
      },
      saved,
      skipped,
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
