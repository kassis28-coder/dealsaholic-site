import { getStore } from "@netlify/blobs";

// Affiliate tag from environment â never hardcode
const AFFILIATE_TAG = process.env.AMAZON_PARTNER_TAG || 'daholic-20';

// ââ Merge notes âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// FROM b79b45d (restored):
//   â¢ store.set(id, JSON.stringify(...))  â setJSON does not exist in @netlify/blobs
//   â¢ AFFILIATE_TAG from env var          â was hardcoded 'kethya08-20'
//   â¢ Per-product price/code extraction   â was shared across all products in email
//   â¢ extractCdnImages, extractTitle, extractPromoCode, extractDiscount,
//     getProductContext, buildAffiliateUrl â restored
//   â¢ fetchAmazonMeta with originalPrice + discountPercent
//   â¢ 7-pattern URL extractor with deduplication
//   â¢ Max 5 URLs per email
//   â¢ SKIP logic for empty deals
//   â¢ Detailed console.log throughout
// FROM 9329b4c (preserved):
//   â¢ status: affiliateUrl ? 'approved' : 'pending'
//   â¢ telegramMessage / facebookMessage in response body
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function extractCdnImages(html) {
  const seen = new Set();
  const images = [];
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)) {
    const src = m[1];
    if (
      src &&
      (src.includes('m.media-amazon.com') ||
        src.includes('images-na.ssl-images-amazon.com') ||
        src.includes('images-amazon.com') ||
        src.includes('ssl-images-amazon.com')) &&
      !seen.has(src) &&
      !src.includes('pixel') &&
      !src.includes('1x1') &&
      !src.includes('_.gif') &&
      !src.includes('transparent')
    ) {
      seen.add(src);
      images.push(src);
    }
  }
  for (const m of html.matchAll(
    /https?:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-amazon\.com|ssl-images-amazon\.com)\/images\/I\/[^\s"'<>&]+/gi
  )) {
    const src = m[0].replace(/[.,;)>\]]+$/, '');
    if (!seen.has(src) && !src.includes('pixel') && !src.includes('1x1')) {
      seen.add(src);
      images.push(src);
    }
  }
  return images.filter(
    u =>
      !u.includes('._SL75_') && !u.includes('._SS40_') &&
      !u.includes('._SX38_') && !u.includes('._SL30_') &&
      !u.includes('._AC_US40_') && !u.includes('._AC_US60_')
  );
}

function extractAmazonUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    /https?:\/\/(?:www\.)?amazon\.com\/[a-zA-Z0-9\-]+\/dp\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    /https?:\/\/(?:www\.)?amazon\.com\/(?:deal|deals|gp\/goldbox|gp\/deal|b\/ref)[^\s"'<>]*/gi,
    /https?:\/\/(?:www\.)?amazon\.com\/(?:coupon|coupons|promo|promotion|gp\/promotions)[^\s"'<>]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
    /https?:\/\/(?:www\.)?amazon\.com\/[a-zA-Z0-9\-_%+\/?.=&#@!]{15,}[^\s"'<>]*/gi,
  ];
  const seen = new Set();
  const urls = [];
  for (const pattern of patterns) {
    for (const m of text.matchAll(new RegExp(pattern.source, 'gi'))) {
      const url = m[0].replace(/[.,;)>\]"']+$/, '');
      if (!seen.has(url)) { seen.add(url); urls.push(url); }
    }
  }
  return urls;
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function buildAffiliateUrl(asin, rawUrl) {
  if (asin) return `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('tag', AFFILIATE_TAG);
    return u.toString();
  } catch {
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}tag=${AFFILIATE_TAG}`;
  }
}

async function resolveAsin(url) {
  try {
    const res = await fetch(url, {
      method: 'HEAD', redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    });
    return res.url?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
  } catch { return null; }
}

function parseDollar(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

async function fetchAmazonMeta(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;

    const asin = res.url?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    const html = await res.text();

    const title =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;

    const image =
      html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1] ||
      html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1] ||
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https:\/\/[^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["'](https:\/\/[^"']+)["']/i)?.[1] ||
      (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);

    const salePriceMatch =
      html.match(/"priceAmount":([\d.]+)/) ||
      html.match(/"salePrice"\s*:\s*\{\s*"amount"\s*:\s*([\d.]+)/) ||
      html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const currentPriceNum = salePriceMatch ? parseDollar(salePriceMatch[1]) : null;
    const price = currentPriceNum ? `$${currentPriceNum.toFixed(2)}` : null;

    const originalPriceMatch =
      html.match(/"listPrice"\s*:\s*\{\s*"amount"\s*:\s*([\d.]+)/) ||
      html.match(/"wasPrice"\s*:\s*\{\s*"amount"\s*:\s*([\d.]+)/) ||
      html.match(/"basisPrice"\s*:\s*\{\s*"amount"\s*:\s*([\d.]+)/) ||
      html.match(/class=["'][^"']*a-text-price[^"']*["'][^>]*>[^<]*<span[^>]*>\$([\d,]+\.?\d{0,2})<\/span>/) ||
      html.match(/class=["'][^"']*priceBlockStrikePriceString[^"']*["'][^>]*>\$([\d,]+\.?\d{0,2})/) ||
      html.match(/List Price:\s*<\/span>[^<]*<span[^>]*>\$([\d,]+\.?\d{0,2})/i) ||
      html.match(/Was:\s*<\/span>[^<]*<span[^>]*>\$([\d,]+\.?\d{0,2})/i);
    const originalPriceNum = originalPriceMatch ? parseDollar(originalPriceMatch[1]) : null;
    const originalPrice = originalPriceNum ? `$${originalPriceNum.toFixed(2)}` : null;

    let discountPercent = null;
    if (currentPriceNum && originalPriceNum && originalPriceNum > currentPriceNum) {
      discountPercent = Math.round((1 - currentPriceNum / originalPriceNum) * 100);
    }
    if (!discountPercent) {
      const dpMatch =
        html.match(/["']savingsPercentage["']\s*:\s*["']?(\d+)%?["']?/) ||
        html.match(/\((\d+)%\s*off\)/i);
      if (dpMatch) discountPercent = parseInt(dpMatch[1], 10);
    }

    return {
      title: title
        ?.replace(/\s*[|:]\s*amazon\b.*/i, '')
        .replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '')
        .trim().substring(0, 150) || null,
      image, price, originalPrice, discountPercent, asin,
    };
  } catch { return null; }
}

function extractPromoCode(text) {
  if (!text) return null;
  const patterns = [
    /\buse\s+code[:\s]+([A-Z0-9]{4,20})\b/i,
    /\bpromo\s*code[:\s]+([A-Z0-9]{4,20})\b/i,
    /\bcoupon\s*code[:\s]+([A-Z0-9]{4,20})\b/i,
    /\bdiscount\s+code[:\s]+([A-Z0-9]{4,20})\b/i,
    /\bapply\s+code[:\s]+([A-Z0-9]{4,20})\b/i,
    /\benter\s+code[:\s]+([A-Z0-9]{4,20})\b/i,
    /\bwith\s+code[:\s]+([A-Z0-9]{4,20})\b/i,
    /\bcode[:\s]+([A-Z0-9]{4,20})\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function extractDiscount(text) {
  if (!text) return null;
  return (
    text.match(/save\s+(\d+)\s*%/i)?.[1] ||
    text.match(/extra\s+(\d+)\s*%\s*off/i)?.[1] ||
    text.match(/(\d+)\s*%\s*off/i)?.[1] ||
    text.match(/(\d+)\s*%\s*discount/i)?.[1] ||
    text.match(/(\d+)\s*%\s*savings/i)?.[1] ||
    null
  );
}

function extractTitle(text) {
  if (!text) return null;
  const saveMatch =
    text.match(/save\s+\d+%?\s+on\s+(.{10,150}?)(?:\n|\.|!|$)/i) ||
    text.match(/extra\s+\d+%?\s+off\s+(?:on\s+)?(.{10,150}?)(?:\n|\.|!|$)/i) ||
    text.match(/\d+%\s+off\s+(?:on\s+)?(.{10,150}?)(?:\n|\.|!|$)/i);
  if (saveMatch) return saveMatch[1].trim().replace(/\s+/g, ' ').substring(0, 150);
  const lines = text.split(/\n/).map(l => l.trim())
    .filter(l => l.length > 15 && !l.startsWith('http') && !/^\d+%/.test(l) && !/^unsubscribe/i.test(l));
  return lines[0]?.substring(0, 150) || null;
}

function getProductContext(rawHtml, url, asin) {
  let pos = url ? rawHtml.indexOf(url.substring(0, 50)) : -1;
  if (pos === -1 && asin) pos = rawHtml.indexOf(asin);
  if (pos === -1) return null;
  const start = Math.max(0, pos - 600);
  const end = Math.min(rawHtml.length, pos + 600);
  return stripHtml(rawHtml.substring(start, end));
}

export default async (req, context) => {
  const urlObj = new URL(req.url);
  let emailBody = '';
  let emailText = '';

  if (req.method === 'GET') {
    emailBody = urlObj.searchParams.get('emailBody') || urlObj.searchParams.get('title') || '';
  } else if (req.method === 'POST') {
    try {
      const ct = req.headers.get('content-type') || '';
      if (ct.includes('application/x-www-form-urlencoded')) {
        const fd = await req.formData();
        emailBody = fd.get('emailBody') || '';
        emailText = fd.get('emailText') || '';
        console.log(`[EMAIL] Form POST | emailBody:${emailBody.length} chars | emailText:${emailText.length} chars`);
      } else if (ct.includes('application/json')) {
        const json = JSON.parse(await req.text());
        emailBody = json.emailBody || json.html || '';
        emailText = json.emailText || '';
      } else {
        emailBody = await req.text();
      }
    } catch (e) {
      console.log(`[EMAIL] Body parse error: ${e.message}`);
      emailBody = '';
    }
  }

  const rawHtml = emailBody.trim();
  console.log(`[EMAIL] Received | method:${req.method} | length:${rawHtml.length}`);

  if (!rawHtml) {
    return new Response(JSON.stringify({ success: true, count: 0, ids: [], deals: [] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  const cdnImages = extractCdnImages(rawHtml);
  console.log(`[EMAIL] CDN images found: ${cdnImages.length}`);

  const plainText = stripHtml(rawHtml) || emailText;
  const allUrls = [...new Set([
    ...extractAmazonUrls(rawHtml),
    ...extractAmazonUrls(plainText),
    ...extractAmazonUrls(emailText),
  ])];
  console.log(`[EMAIL] Amazon URLs found: ${allUrls.length}`);

  const store = getStore('submissions');
  const savedIds = [];
  const deals = [];
  const urlsToProcess = allUrls.length > 0 ? allUrls.slice(0, 5) : [null];

  for (let i = 0; i < urlsToProcess.length; i++) {
    const rawUrl = urlsToProcess[i];

    let asin = rawUrl?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    if (rawUrl && !asin) asin = await resolveAsin(rawUrl);

    let meta = null;
    if (rawUrl) {
      meta = await fetchAmazonMeta(rawUrl);
      if (meta?.asin && !asin) asin = meta.asin;
      console.log(`[EMAIL] [${i}] meta title="${meta?.title?.substring(0, 50) || 'none'}" price=${meta?.price || 'none'} originalPrice=${meta?.originalPrice || 'none'} discount=${meta?.discountPercent ?? 'none'}% asin=${asin || 'none'}`);
    }

    const productCtx = getProductContext(rawHtml, rawUrl, asin);
    const affiliateUrl = buildAffiliateUrl(asin, rawUrl);

    const imageUrl =
      meta?.image || cdnImages[i] || cdnImages[0] ||
      (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);

    const title = meta?.title || (productCtx ? extractTitle(productCtx) : null) || null;
    const price = meta?.price || (productCtx ? productCtx.match(/\$[\d,]+\.?\d{0,2}/)?.[0] : null) || null;
    const originalPrice = meta?.originalPrice || null;

    const discountFromText = extractDiscount(productCtx) || extractDiscount(plainText);
    const discount = meta?.discountPercent != null ? String(meta.discountPercent) : discountFromText || null;

    const discountCode =
      extractPromoCode(plainText) ||
      extractPromoCode(emailText) ||
      extractPromoCode(productCtx);

    console.log(`[EMAIL] [${i}] title="${(title || 'null').substring(0, 50)}" price=${price || 'null'} originalPrice=${originalPrice || 'null'} code=${discountCode || 'null'} discount=${discount || 'null'}%`);

    if (!affiliateUrl && !imageUrl && !discount && !discountCode && !title) {
      console.log(`[EMAIL] [${i}] SKIP â no usable fields`);
      continue;
    }

    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id,
      title: title || null,
      price: price || null,
      originalPrice: originalPrice || null,
      discount: discount || null,
      url: affiliateUrl || '',
      imageUrl: imageUrl || null,
      discountCode: discountCode || null,
      source: 'email',
      status: affiliateUrl ? 'approved' : 'pending',
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.set(id, JSON.stringify(submission));

    let index = [];
    try { index = await store.get('index', { type: 'json' }) || []; } catch { index = []; }
    index.unshift(id);
    await store.set('index', JSON.stringify(index));
    await new Promise(r => setTimeout(r, 10));

    savedIds.push(id);
    deals.push({ id, title, price, originalPrice, discount, url: affiliateUrl || '', imageUrl });
    console.log(`[EMAIL] [${i}] Saved | id:${id} | status:${submission.status}`);
  }

  console.log(`[EMAIL] Done | saved ${deals.length} deal(s)`);

  const telegramMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `ð¥ <b>New Deal Alert!</b>\n\nðï¸ <b>${deals[0].title || 'Amazon Deal'}</b>\n\nð° <b>${deals[0].price || 'Check link'}</b>\n\nð <a href="${deals[0].url}">ð Grab this deal!</a>`
      : `ð¥ <b>${deals.length} New Deals Alert!</b>\n\n` + deals.map((d, idx) =>
          `${idx + 1}. ðï¸ <b>${d.title || 'Amazon Deal'}</b>\n   ð° <b>${d.price || 'Check link'}</b>\n   ð <a href="${d.url}">Grab deal</a>`
        ).join('\n\n');

  const facebookMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `ð¥ New Deal Alert!\n\nðï¸ ${deals[0].title || 'Amazon Deal'}\n\nð° ${deals[0].price || 'Check link'}\n\nð ${deals[0].url}\n\n#deals #amazon #dealsaholic #shopping #sale`
      : `ð¥ ${deals.length} New Deals Alert!\n\n` + deals.map((d, idx) =>
          `${idx + 1}. ðï¸ ${d.title || 'Amazon Deal'}\n   ð° ${d.price || 'Check link'}\n   ð ${d.url}`
        ).join('\n\n') + '\n\n#deals #amazon #dealsaholic #shopping #sale';

  return new Response(JSON.stringify({
    success: true,
    count: deals.length,
    ids: savedIds,
    deals,
    amazonUrlsFound: allUrls.length,
    telegramMessage,
    facebookMessage,
    title: deals[0]?.title || null,
    price: deals[0]?.price || null,
    originalPrice: deals[0]?.originalPrice || null,
    url: deals[0]?.url || null,
    imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/submit-email-deal' };
