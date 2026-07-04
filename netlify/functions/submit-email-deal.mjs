    import { getStore } from "@netlify/blobs";

async function followRedirectForAsin(amazonUrl) {
  try {
    const res = await fetch(amazonUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    });
    const finalUrl = res.url || amazonUrl;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    return { asin, finalUrl };
  } catch (e) {
    return { asin: null, finalUrl: amazonUrl };
  }
}

async function fetchAmazonMeta(amazonUrl) {
  const { asin: asinFromRedirect, finalUrl: redirectUrl } = await followRedirectForAsin(amazonUrl);
  try {
    const res = await fetch(amazonUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      if (!asinFromRedirect) return null;
      return { title: null, price: null, image: `https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg`, asin: asinFromRedirect, finalUrl: redirectUrl };
    }
    const finalUrl = res.url;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || asinFromRedirect || null;
    const html = await res.text();
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const image = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);
    const priceMatch = html.match(/["']priceAmount["']\s*:\s*["']?([\d.]+)["']?/)
      || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;
    return {
      title: title?.replace(/\s*[|:]\s*amazon\b.*/i, '').replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '').trim().substring(0, 150) || null,
      image, price, asin, finalUrl,
    };
  } catch (e) {
    if (!asinFromRedirect) return null;
    return { title: null, price: null, image: `https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg`, asin: asinFromRedirect, finalUrl: redirectUrl };
  }
}

function extractAmazonUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
  ];
  const urls = [];
  for (const pattern of patterns) {
    [...text.matchAll(new RegExp(pattern.source, 'gi'))].forEach(m => urls.push(m[0]));
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

export default async (req, context) => {
  const urlObj = new URL(req.url);
  let emailBody = '', title = '', snippet = '';

  if (req.method === 'GET') {
    emailBody = urlObj.searchParams.get('emailBody') || '';
    title = urlObj.searchParams.get('title') || '';
    snippet = urlObj.searchParams.get('snippet') || '';
  } else if (req.method === 'POST') {
    try { emailBody = await req.text(); } catch (e) { emailBody = ''; }
  }

  const content = (emailBody || title).trim();

  let claudeData = null;
  let rawSnippet = snippet;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.title || parsed.amazonUrl) claudeData = parsed;
      if (parsed.snippet) rawSnippet = parsed.snippet;
      if (parsed.emailSnippet) rawSnippet = rawSnippet || parsed.emailSnippet;
      if (parsed.emailBody) {
        emailBody = parsed.emailBody;
        try {
          const inner = JSON.parse(parsed.emailBody);
          if (inner && typeof inner === 'object' && (inner.title || inner.amazonUrl)) claudeData = inner;
        } catch (e) {}
      }
    }
  } catch (e) {}

  const plainText = stripHtml(content);
  const allUrls = [];
  if (claudeData?.amazonUrl) allUrls.push(claudeData.amazonUrl);
  extractAmazonUrls(content).forEach(u => allUrls.push(u));
  extractAmazonUrls(plainText).forEach(u => allUrls.push(u));
  if (rawSnippet) {
    extractAmazonUrls(rawSnippet).forEach(u => allUrls.push(u));
    extractAmazonUrls(stripHtml(rawSnippet)).forEach(u => allUrls.push(u));
  }

  const uniqueUrls = [...new Set(allUrls)];
  const primaryUrl = uniqueUrls[0] || null;
  let primaryMeta = null;
  if (primaryUrl) primaryMeta = await fetchAmazonMeta(primaryUrl);

  const sharedPrice = claudeData?.price || primaryMeta?.price || plainText.match(/\$[\d,.]+/)?.[0] || null;
  const originalPrice = claudeData?.originalPrice || null;
  const discount = claudeData?.discount || plainText.match(/(\d+)\s*%\s*(?:off|discount)/i)?.[1] || null;
  const discountCode = claudeData?.discountCode || plainText.match(/(?:code|coupon|promo)[:\s]+([A-Z0-9]{4,20})/i)?.[1] || null;

  const store = getStore("submissions");
  const urlsToProcess = uniqueUrls.length > 0 ? uniqueUrls.slice(0, 20) : [null];
  const savedIds = [];
  const deals = [];

  for (const dealUrl of urlsToProcess) {
    let meta = dealUrl === primaryUrl ? primaryMeta : null;
    if (!meta && dealUrl) meta = await fetchAmazonMeta(dealUrl);
    const asin = dealUrl?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || meta?.asin || null;
    const affiliateUrl = asin
      ? 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20'
      : dealUrl
      ? (dealUrl.includes('tag=') ? dealUrl : dealUrl + (dealUrl.includes('?') ? '&' : '?') + 'tag=kethya08-20')
      : '';
    const imageUrl = meta?.image || (asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg' : null);
    const dealTitle = meta?.title
      || (dealUrl === primaryUrl ? claudeData?.title : null)
      || plainText.split(/[\n.!?]/).find(l => l.trim().length > 10 && !l.includes('http'))?.trim().substring(0, 150)
      || 'Amazon Deal';
    const dealPrice = meta?.price || (dealUrl === primaryUrl ? claudeData?.price : null) || sharedPrice;
    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id, title: dealTitle, price: dealPrice || null, originalPrice: originalPrice || null,
      discount: discount || null, url: affiliateUrl, imageUrl, discountCode: discountCode || null,
      source: "email", status: affiliateUrl ? "approved" : "pending", sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await store.setJSON(id, submission);
    savedIds.push(id);
    deals.push({ id, title: dealTitle, price: dealPrice || null, url: affiliateUrl, imageUrl });
    let index = [];
    try { index = await store.get("index", { type: "json" }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);
    await new Promise(r => setTimeout(r, 10));
  }

  const telegramMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 <b>New Deal Alert!</b>\n\n🛍️ <b>${deals[0].title || 'Amazon Deal'}</b>\n\n💰 <b>${deals[0].price || 'Check link'}</b>\n\n🔗 <a href="${deals[0].url}">👉 Grab this deal!</a>`
      : `🔥 <b>${deals.length} New Deals Alert!</b>\n\n` + deals.map((d, i) =>
          `${i + 1}. 🛍️ <b>${d.title || 'Amazon Deal'}</b>\n   💰 <b>${d.price || 'Check link'}</b>\n   🔗 <a href="${d.url}">Grab deal</a>`
        ).join('\n\n');

  const facebookMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 New Deal Alert!\n\n🛍️ ${deals[0].title || 'Amazon Deal'}\n\n💰 ${deals[0].price || 'Check link'}\n\n👉 ${deals[0].url}\n\n#deals #amazon #dealsaholic #shopping #sale`
      : `🔥 ${deals.length} New Deals Alert!\n\n` + deals.map((d, i) =>
          `${i + 1}. 🛍️ ${d.title || 'Amazon Deal'}\n   💰 ${d.price || 'Check link'}\n   👉 ${d.url}`
        ).join('\n\n') + '\n\n#deals #amazon #dealsaholic #shopping #sale';

  return new Response(JSON.stringify({
    success: true, count: deals.length, ids: savedIds, deals,
    amazonUrlsFound: uniqueUrls.length,
    telegramMessage, facebookMessage,
    title: deals[0]?.title || null, price: deals[0]?.price || null,
    url: deals[0]?.url || null, imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

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
    .replace(/\s*original\s+price.*/i, '')
    .replace(/\s*discount\s+price.*/i, '')
    .replace(/\s*deal\s+price.*/i, '')
    .replace(/\s*\d+%\s*(?:off|prime|code).*/i, '')
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

function getContextAroundUrl(text, url, asin, windowSize = 600) {
  let idx = asin ? text.indexOf(asin) : -1;
  if (idx === -1) idx = text.indexOf(url);
  if (idx === -1) return text.substring(0, 1000);
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + (asin || url).length + windowSize);
  return text.slice(start, end);
}

function extractTitle(context) {
  const patterns = [
    /product\s*name\s*[：:]\s*([^\n\r]{5,200})/i,
    /#[\w\d]+\s*[\n\r]+\s*[\d]+%\s*off\s+([^\n\r]{5,150})/i,
    /[\d]+%\s*off\s+([A-Z][^\n\r]{5,150})/i,
    /#[\w\d]+\s*[\n\r]+\s*([A-Z][^\n\r]{5,150})/,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) {
      const raw = m[1].trim().split(/[\n\r]/)[0];
      const clean = raw
        .replace(/\s*\d+%\s*(?:off|prime|code|discount).*/i, '')
        .replace(/\s*(?:original|discount|deal|final|sale)\s*price.*/i, '')
        .replace(/\s*\$[\d.]+.*/i, '')
        .replace(/\s*\(Reg.*/i, '')
        .replace(/\s*discount\s*:.*/i, '')
        .trim();
      if (clean.length >= 5) return cleanTitle(clean);
    }
  }
  return null;
}

function extractPrice(context) {
  const patterns = [
    /(?:deal|discount|final|sale)\s*price\s*[：:]\s*\$?([\d.]+)/i,
    /\$?([\d.]+)\s*\(Reg/i,
    /\$\s*([\d.]+)/,
    /price\s*[：:]\s*([\d.]+)/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m && parseFloat(m[1]) > 0 && parseFloat(m[1]) < 10000) {
      return '$' + parseFloat(m[1]).toFixed(2);
    }
  }
  return null;
}

function extractOriginalPrice(context) {
  const patterns = [
    /(?:original|ori\.?|reg\.?)\s*price\s*[：:]\s*\$?([\d.]+)/i,
    /\(Reg\.?\s*\$?([\d.]+)/i,
    /was\s*[：:]\s*\$?([\d.]+)/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return '$' + parseFloat(m[1]).toFixed(2);
  }
  return null;
}

function extractDiscount(context) {
  const patterns = [
    /discount\s*[：:]\s*(\d+)\s*%/i,
    /(\d+)\s*%\s*off/i,
    /off\s*[：:]\s*(\d+)\s*%/i,
    /(\d+)\s*%\s*(?:code|discount|coupon|OFF)/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return parseInt(m[1]);
  }
  return null;
}

function extractPromoCode(context) {
  const patterns = [
    /discount\s*code\s*[：:\s]+([A-Z0-9]{4,20})/i,
    /promo\s*code\s*[：:\s]+([A-Z0-9]{4,20})/i,
    /coupon\s*code\s*[：:\s]+([A-Z0-9]{4,20})/i,
    /\bcode\s*[：:\s]+([A-Z0-9]{4,20})\b/i,
    /\d+%\s*(?:off\s*)?(?:code|CODE)\s*[：:\s]+([A-Z0-9]{4,20})/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) {
      const code = m[1].trim().toUpperCase();
      if (code.match(/^B0[A-Z0-9]{8}$/)) continue;
      if (['DEAL', 'CODE', 'PROMO', 'SALE', 'OFF', 'DISCOUNT', 'COUPON', 'FREE'].includes(code)) continue;
      return code;
    }
  }
  return null;
}

function extractRating(context) {
  const m = context.match(/([\d.]+)\s*Stars?,\s*(\d+)\s*ratings?/i);
  if (m) return { rating: parseFloat(m[1]), ratingCount: parseInt(m[2]) };
  return { rating: null, ratingCount: null };
}

function extractExpiryDate(context) {
  const patterns = [
    /(?:code\s*end\s*day|end\s*day|expire[sd]?|expiry)\s*[：:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i,
    /(?:end|expire[sd]?)\s*(?:date|day)\s*[：:\s]+(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})/i,
    /expir\w*\s*[：:\s]+(\d{4}[-\/]\d{1,2}[-\/]\d{1,2})/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) {
      try {
        const datePart = m[1].replace(/(\d{4}-\d{1,2}-\d{2})\d+.*/, '$1');
        const d = new Date(datePart);
        if (!isNaN(d.getTime())) return d.toISOString();
      } catch (e) {}
    }
  }
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
}

async function scrapeAmazon(asin) {
  try {
    const res = await fetch('https://www.amazon.com/dp/' + asin, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const image = html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/"thumb":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https:\/\/m\.media-amazon\.com\/images\/I\/[^"']+)["']/i)?.[1]
      || null;
    if (!image) {
      const widgetUrl = `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL250_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822&WS=1`;
      return { title: cleanTitle(title), image: widgetUrl };
    }
    return { title: cleanTitle(title), image };
  } catch (e) {
    const widgetUrl = `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL250_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822&WS=1`;
    return { title: null, image: widgetUrl };
  }
}

async function sha256hex(data) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, typeof data === 'string' ? new TextEncoder().encode(data) : data);
}

async function hmacHex(key, data) {
  const sig = await hmac(key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey(secret, date, region, service) {
  const kDate = await hmac('AWS4' + secret, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

async function uploadToR2(imageUrl, asin) {
  try {
    const endpoint = process.env.R2_ENDPOINT;
    const bucket = process.env.R2_BUCKET_NAME;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!endpoint || !bucket || !accessKey || !secretKey) return null;

    const imgRes = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.amazon.com/',
      }
    });
    if (!imgRes.ok) return null;

    const buffer = await imgRes.arrayBuffer();
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
    const filename = `deals/${asin}.${ext}`;
    const url = `${endpoint}/${bucket}/${filename}`;

    const date = new Date();
    const dateStr = date.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateShort = dateStr.slice(0, 8);
    const bodyHash = await sha256hex(buffer);
    const canonicalHeaders = `content-type:${contentType}\nhost:${new URL(endpoint).host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${dateStr}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `PUT\n/${bucket}/${filename}\n\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;
    const credentialScope = `${dateShort}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${await sha256hex(new TextEncoder().encode(canonicalRequest))}`;
    const signingKey = await getSigningKey(secretKey, dateShort, 'auto', 's3');
    const signature = await hmacHex(signingKey, stringToSign);
    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const uploadRes = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-amz-content-sha256': bodyHash,
        'x-amz-date': dateStr,
        'Authorization': authorization,
      },
      body: buffer,
    });

    if (!uploadRes.ok) return null;
    return `${publicUrl}/${filename}`;
  } catch (e) {
    console.error('R2 upload failed:', e.message);
    return null;
  }
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
  const allUrls = [...htmlUrls, ...textUrls].filter(({ url, asin }) => {
    if (url.includes('/promocode/') && !asin) return false;
    return true;
  });

  const queueStore = getStore("deal-queue");
  const submissionsStore = getStore("submissions");

  let queue = [];
  try { queue = await queueStore.get('queue', { type: 'json' }) || []; } catch (e) { queue = []; }

  // Load recent submission ASINs for dedup check
  let recentAsins = new Set();
  try {
    const index = await submissionsStore.get('index', { type: 'json' }) || [];
    const recent = index.slice(0, 100);
    for (const id of recent) {
      try {
        const sub = await submissionsStore.get(id, { type: 'json' });
        if (sub?.asin) recentAsins.add(sub.asin);
      } catch (e) {}
    }
  } catch (e) {}

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
    const titleFromEmail = extractTitle(ctx);

    if (!discount || discount < 50) { skipped.push({ url, reason: 'discount < 50%', discount }); continue; }
    if (ratingCount === 0) { skipped.push({ url, reason: '0 ratings' }); continue; }
    if (rating !== null && rating < 4.0) { skipped.push({ url, reason: 'rating < 4.0', rating }); continue; }
    if (isAdultContent(titleFromEmail, ctx)) { skipped.push({ url, reason: 'adult content' }); continue; }

    // Dedup check — skip if ASIN already in queue or recently posted
    if (asin && queue.some(q => q.asin === asin)) {
      skipped.push({ url, reason: 'duplicate - already in queue' });
      continue;
    }
    if (asin && recentAsins.has(asin)) {
      skipped.push({ url, reason: 'duplicate - already posted recently' });
      continue;
    }

    const price = extractPrice(ctx);
    const originalPrice = extractOriginalPrice(ctx);
    const promoCode = extractPromoCode(ctx);
    const expiresOn = extractExpiryDate(ctx);

    let affiliateUrl, imageUrl = null;
    let title = titleFromEmail;

    if (dealStore === 'amazon' && asin) {
      affiliateUrl = 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20';
      const scraped = await scrapeAmazon(asin);
      if (scraped) {
        if (!title && scraped.title) title = scraped.title;
        if (scraped.image) {
          const r2Url = await uploadToR2(scraped.image, asin);
          imageUrl = r2Url || scraped.image;
        }
      }
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
      expiresOn,
      addedAt: new Date().toISOString(),
    };

    queue.push(queueItem);
    added++;
    await new Promise(r => setTimeout(r, 500));
  }

  await queueStore.setJSON('queue', queue);

  // Get the last added deal for social media posting
  const lastDeal = queue[queue.length - 1] || null;

  return new Response(JSON.stringify({
    success: true,
    totalFound: allUrls.length,
    added,
    skipped: skipped.length,
    queueLength: queue.length,
    skipReasons: skipped.slice(0, 10),
    // Return first deal data for Make.com Facebook posting
    title: lastDeal?.title || null,
    price: lastDeal?.price || null,
    promoCode: lastDeal?.promoCode || null,
    imageUrl: lastDeal?.imageUrl || null,
    url: lastDeal?.url || null,
    discount: lastDeal?.discount || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

export const config = { path: '/api/submit-email-deal' };
