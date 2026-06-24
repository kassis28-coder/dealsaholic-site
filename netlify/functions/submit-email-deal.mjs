import { getStore } from "@netlify/blobs";

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function cleanTitle(title) {
  if (!title) return null;
  return decodeHtmlEntities(title)
    .replace(/^amazon\.com\s*[:]\s*/i, '')
    .replace(/^walmart\.com\s*[:]\s*/i, '')
    .replace(/\s*[|:]\s*amazon\.com.*/i, '')
    .replace(/\s*[|:]\s*walmart\.com.*/i, '')
    .replace(/\s*-\s*amazon\.com.*/i, '')
    .replace(/\s*-\s*walmart\.com.*/i, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^["'\u201c]|["'\u201d]$/g, '')
    .trim()
    .substring(0, 150);
}

function isAdultContent(title, context) {
  const blocked = [
    'lingerie', 'babydoll', 'teddy lingerie', 'sexy', 'erotic',
    'adult toy', 'vibrator', 'dildo', 'penis', 'thong', 'g-string',
    'mesh bodysuit', 'nipple', 'fetish', 'bondage', 'sheer mesh',
    'lace bodysuit', 'plus size lingerie', 'bra panty', 'crotchless',
    'strip', 'nude', 'explicit', 'sexual', 'kinky', 'naughty',
  ];
  const text = ((title || '') + ' ' + (context || '')).toLowerCase();
  return blocked.some(word => text.includes(word));
}

function extractUrlsFromHtml(html) {
  const seen = new Set();
  const urls = [];
  const hrefPattern = /href=["']([^"']*(?:amazon\.com|walmart\.com)[^"']*)/gi;
  let m;
  while ((m = hrefPattern.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&');
    if (url.includes('amazon.com')) {
      const asin = url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]
        || url.match(/\/gp\/product\/([A-Z0-9]{10})/i)?.[1];
      if (!asin || seen.has(asin)) continue;
      seen.add(asin);
      urls.push({ url: 'https://www.amazon.com/dp/' + asin, asin, store: 'amazon' });
    } else if (url.includes('walmart.com/ip/')) {
      const itemId = url.match(/\/ip\/(?:[^/]+\/)?(\d+)/)?.[1];
      if (!itemId || seen.has('wmt-' + itemId)) continue;
      seen.add('wmt-' + itemId);
      urls.push({ url: 'https://www.walmart.com/ip/' + itemId, asin: null, itemId, store: 'walmart' });
    }
  }
  return { urls, seen };
}

function extractUrlsFromText(text, seen) {
  const urls = [];
  const patterns = [
    { pattern: /https?:\/\/(?:www\.)?amazon\.com\/dp\/([A-Z0-9]{10})[^\s"'<>\u201d]*/gi, store: 'amazon' },
    { pattern: /https?:\/\/(?:www\.)?amazon\.com\/gp\/product\/([A-Z0-9]{10})[^\s"'<>\u201d]*/gi, store: 'amazon' },
    { pattern: /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi, store: 'amazon' },
    { pattern: /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi, store: 'amazon' },
    { pattern: /https?:\/\/(?:www\.)?walmart\.com\/ip\/(?:[^/\s]+\/)?(\d{6,12})[^\s"'<>\u201d]*/gi, store: 'walmart' },
  ];
  for (const { pattern, store } of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const url = m[0].replace(/["\u201d\u201c']+$/, '');
      if (store === 'amazon') {
        const asin = url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]
          || url.match(/\/product\/([A-Z0-9]{10})/i)?.[1];
        const key = asin || url;
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push({ url: asin ? 'https://www.amazon.com/dp/' + asin : url, asin: asin || null, store: 'amazon' });
      } else if (store === 'walmart') {
        const itemId = url.match(/\/ip\/(?:[^/\s]+\/)?(\d{6,12})/)?.[1];
        if (!itemId) continue;
        const key = 'wmt-' + itemId;
        if (seen.has(key)) continue;
        seen.add(key);
        urls.push({ url: 'https://www.walmart.com/ip/' + itemId, asin: null, itemId, store: 'walmart' });
      }
    }
  }
  return urls;
}

function getContextAroundUrl(text, url, asin, windowSize = 400) {
  let idx = asin ? text.indexOf(asin) : -1;
  if (idx === -1) idx = text.indexOf(url);
  if (idx === -1) return text.substring(0, 800);
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + (asin || url).length + windowSize);
  return text.slice(start, end);
}

function extractPrice(context) {
  const patterns = [
    /deal\s+price\s*[:$]?\s*\$?([\d.]+)/i,
    /discount\s+price\s*[:$]?\s*\$?([\d.]+)/i,
    /\n([\d.]+)(?:-[\d.]+)?\s*\(Reg/i,
    /price\s*[:$]?\s*\$?([\d.]+)/i,
    /\$([\d.]+)/,
    /\b([\d.]+)\s*\(Reg/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m && parseFloat(m[1]) > 0 && parseFloat(m[1]) < 10000) return '$' + m[1];
  }
  return null;
}

function extractOriginalPrice(context) {
  const patterns = [
    /\(Reg\.?\s*\$?([\d.]+)/i,
    /original\s+price\s*[:$]?\s*\$?([\d.]+)/i,
    /was\s*[:$]?\s*\$?([\d.]+)/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return '$' + m[1];
  }
  return null;
}

function extractDiscount(context) {
  const m = context.match(/(\d+)\s*%\s*(?:off|code|discount)/i);
  return m ? parseInt(m[1]) : null;
}

function extractPromoCode(context) {
  const patterns = [
    /(?:use|apply|enter|add|with)\s+(?:promo(?:tional)?\s+)?code[:\s]+([A-Z0-9]{4,20})/i,
    /(?:promo(?:tional)?|coupon|discount)\s+code[:\s]+([A-Z0-9]{4,20})/i,
    /\bcode[:\u3001:\s]+([A-Z0-9]{6,20})\b/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function extractRating(context) {
  const m = context.match(/([\d.]+)\s*Stars?,\s*(\d+)\s*ratings?/i);
  if (m) return { rating: parseFloat(m[1]), ratingCount: parseInt(m[2]) };
  return { rating: null, ratingCount: null };
}

function extractTitleFromContext(context) {
  const patterns = [
    /product\s+name[:\u3001\s]+"?([^\n"]{10,200})/i,
    /\d+%\s+off\s+([A-Z][^{\n}]{10,100})(?:\n|$)/,
    /#\d+\s+([A-Z][^\n]{10,150})/,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return cleanTitle(m[1].trim());
  }
  return null;
}

export default async (req, context) => {
  let emailBody = '';
  let emailText = '';

  if (req.method === 'GET') {
    const urlObj = new URL(req.url);
    emailBody = urlObj.searchParams.get('emailBody') || '';
    emailText = urlObj.searchParams.get('emailText') || '';
  } else if (req.method === 'POST') {
    try {
      const raw = await req.text();
      const contentType = req.headers.get('content-type') || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(raw);
        emailBody = params.get('emailBody') || '';
        emailText = params.get('emailText') || '';
      } else {
        try {
          const parsed = JSON.parse(raw);
          emailBody = parsed.emailBody || parsed.body || '';
          emailText = parsed.emailText || '';
        } catch (e) {
          emailBody = raw;
        }
      }
    } catch (e) { emailBody = ''; }
  }

  const { urls: htmlUrls, seen } = extractUrlsFromHtml(emailBody);
  const plainText = stripHtml(emailBody) + ' ' + emailText;
  const textUrls = extractUrlsFromText(plainText, seen);
  const allUrls = [...htmlUrls, ...textUrls].filter(({ url }) => !url.includes('/promocode/'));

  const submissionsStore = getStore("submissions");
  const queueStore = getStore("deal-queue");

  let queue = [];
  try { queue = await queueStore.get('queue', { type: 'json' }) || []; } catch (e) { queue = []; }

  const MAX_QUEUE = 200;
  const MAX_PER_EMAIL = 50;
  let added = 0;
  const skipped = [];

  for (const { url, asin, itemId, store: dealStore } of allUrls) {
    if (added >= MAX_PER_EMAIL) break;
    if (queue.length >= MAX_QUEUE) break;

    const ctx = getContextAroundUrl(plainText, url, asin);
    const discount = extractDiscount(ctx);
    const { rating, ratingCount } = extractRating(ctx);
    const title = extractTitleFromContext(ctx);

    if (!discount || discount < 50) { skipped.push({ url, reason: 'discount < 50%', discount }); continue; }
    if (ratingCount === 0) { skipped.push({ url, reason: '0 ratings' }); continue; }
    if (rating !== null && rating < 4.0) { skipped.push({ url, reason: 'rating < 4.0', rating }); continue; }
    if (isAdultContent(title, ctx)) { skipped.push({ url, reason: 'adult content' }); continue; }

    const price = extractPrice(ctx);
    const originalPrice = extractOriginalPrice(ctx);
    const promoCode = extractPromoCode(ctx);
    let affiliateUrl, imageUrl = null;

    if (dealStore === 'amazon' && asin) {
      affiliateUrl = 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20';
      imageUrl = 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg';
    } else if (dealStore === 'walmart' && itemId) {
      affiliateUrl = 'https://www.walmart.com/ip/' + itemId + '?wmlspartner=iplc1788825';
    } else {
      affiliateUrl = url;
    }

    const queueItem = {
      id: 'q-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      title: title || (dealStore === 'walmart' ? 'Walmart Deal' : 'Amazon Deal'),
      price, originalPrice, discount, promoCode,
      url: affiliateUrl, imageUrl,
      asin: asin || null, itemId: itemId || null,
      store: dealStore, rating, ratingCount,
      addedAt: new Date().toISOString(),
    };

    queue.push(queueItem);
    added++;
  }

  await queueStore.setJSON('queue', queue);

  return new Response(JSON.stringify({
    success: true,
    totalFound: allUrls.length,
    added,
    skipped: skipped.length,
    queueLength: queue.length,
    skipReasons: skipped.slice(0, 10),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/submit-email-deal' };
