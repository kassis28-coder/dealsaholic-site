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

function getContextAroundUrl(text, url, asin, windowSize = 600) {
  let idx = asin ? text.indexOf(asin) : -1;
  if (idx === -1) idx = text.indexOf(url);
  if (idx === -1) return text.substring(0, 800);
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + (asin || url).length + windowSize);
  return text.slice(start, end);
}

function extractTitle(context) {
  const patterns = [
    // Format: "Product name: Title" or "Product name：Title"
    /product\s*name\s*[：:]\s*([^\n]{10,200})/i,
    // Format: "#1\n60% off Title" or "#US1\n60% off Title"
    /#[\w\d]+\s*\n\s*[\d]+%\s*(?:off\s+)?([A-Z][^\n]{10,150})/i,
    // Format: "60% off Title" at start of block
    /[\d]+%\s*off\s+([A-Z][^\n]{10,150})/i,
    // Format: "#1\nTitle" (title on next line after number)
    /#[\w\d]+\s*\n\s*([A-Z][^\n]{10,150})/,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return cleanTitle(m[1].trim());
  }
  return null;
}

function extractPrice(context) {
  const patterns = [
    // "Deal Price : 19.99" or "Discount price：19.99" or "Final Price : $11.99"
    /(?:deal|discount|final|sale)\s*price\s*[：:]\s*\$?([\d.]+)/i,
    // "8.88(Reg.21.99)" or "8.88-8.99(Reg"
    /([\d.]+)(?:-[\d.]+)?\s*\(Reg/i,
    // "$12.49"
    /\$\s*([\d.]+)/,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m && parseFloat(m[1]) > 0 && parseFloat(m[1]) < 10000) return '$' + parseFloat(m[1]).toFixed(2);
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
    if (m) return '$' + m[1];
  }
  return null;
}

function extractDiscount(context) {
  const patterns = [
    // "60% off" or "70%OFF"
    /(\d+)\s*%\s*off/i,
    // "off：50%" or "Discount：56%"
    /(?:off|discount)\s*[：:]\s*(\d+)\s*%/i,
    // "50% off Code:"
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
    // "Discount code： E68VLRLF" or "code： J5KU5B33"
    /(?:discount\s*code|promo\s*code|coupon\s*code)\s*[：:\s]+([A-Z0-9]{4,20})/i,
    // "50% off Code: FYOBL7K9"
    /\d+%\s*off\s+(?:Code|CODE)\s*[：:\s]+([A-Z0-9]{4,20})/i,
    // "Code :NZOCPLES" or "code: ABC123"
    /\bcode\s*[：:\s]+([A-Z0-9]{4,20})\b/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) {
      const code = m[1].toUpperCase();
      // Skip if it looks like an ASIN (all caps 10 chars starting with B0)
      if (code.match(/^B0[A-Z0-9]{8}$/)) continue;
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

async function scrapeAmazon(asin) {
  try {
    const res = await fetch('https://www.amazon.com/dp/' + asin, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
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
    return { title: cleanTitle(title), image };
  } catch (e) {
    return null;
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
  const allUrls = [...htmlUrls, ...textUrls];

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

    // Skip promocode-only URLs — they have no ASIN
    if (url.includes('/promocode/') && !asin) continue;

    const ctx = getContextAroundUrl(plainText, url, asin);
    const discount = extractDiscount(ctx);
    const { rating, ratingCount } = extractRating(ctx);
    const titleFromEmail = extractTitle(ctx);

    if (!discount || discount < 50) { skipped.push({ url, reason: 'discount < 50%', discount }); continue; }
    if (ratingCount === 0) { skipped.push({ url, reason: '0 ratings' }); continue; }
    if (rating !== null && rating < 4.0) { skipped.push({ url, reason: 'rating < 4.0', rating }); continue; }
    if (isAdultContent(titleFromEmail, ctx)) { skipped.push({ url, reason: 'adult content' }); continue; }

    const price = extractPrice(ctx);
    const originalPrice = extractOriginalPrice(ctx);
    const promoCode = extractPromoCode(ctx);

    let affiliateUrl, imageUrl = null;
    let title = titleFromEmail;

    if (dealStore === 'amazon' && asin) {
      affiliateUrl = 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20';
      const scraped = await scrapeAmazon(asin);
      if (scraped) {
        title = scraped.title || title;
       if (scraped.image && scraped.image.includes('m.media-amazon.com/images/I/')) {
  const r2Url = await uploadToR2(scraped.image, asin);
  imageUrl = r2Url || scraped.image;
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
      addedAt: new Date().toISOString(),
    };

    queue.push(queueItem);
    added++;
    await new Promise(r => setTimeout(r, 500));
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
