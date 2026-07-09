import { getStore } from "@netlify/blobs";

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

async function uploadToR2(imageBuffer, contentType, filename) {
  try {
    const endpoint = process.env.R2_ENDPOINT;
    const bucket = process.env.R2_BUCKET_NAME;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!endpoint || !bucket || !accessKey || !secretKey) return null;

    const url = `${endpoint}/${bucket}/${filename}`;
    const date = new Date();
    const dateStr = date.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateShort = dateStr.slice(0, 8);
    const bodyHash = await sha256hex(imageBuffer);
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
      body: imageBuffer,
    });

    if (!uploadRes.ok) return null;
    return `${publicUrl}/${filename}`;
  } catch (e) {
    console.error('R2 upload failed:', e.message);
    return null;
  }
}

async function fetchAndUploadImage(imageUrl, asin) {
  try {
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
    return await uploadToR2(buffer, contentType, filename);
  } catch (e) {
    console.error('fetchAndUploadImage failed:', e.message);
    return null;
  }
}

async function getAmazonImage(asin) {
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
    if (res.ok) {
      const html = await res.text();
      const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || null;
      const priceMatch = html.match(/"priceAmount":([\d.]+)/) || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
      const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;
      const image = html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
        || html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
        || html.match(/"thumb":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
        || html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
        || html.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
        || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https:\/\/m\.media-amazon\.com\/images\/I\/[^"']+)["']/i)?.[1]
        || null;
      if (image) return { title, price, image };
    }
  } catch (e) {
    console.error('Scrape failed:', e.message);
  }

  const widgetUrl = `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL250_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822&WS=1`;
  try {
    const testRes = await fetch(widgetUrl, { method: 'HEAD' });
    if (testRes.ok) return { title: null, price: null, image: widgetUrl };
  } catch (e) {}

  return null;
}

async function postToTelegram(deal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return false;

  const storeIcon = deal.store === 'walmart' ? '🛒' : '🛍️';
  const storeName = deal.store === 'walmart' ? 'Walmart.com' : 'Amazon.com';
  const codeLine = deal.promoCode ? '\n🏷 Code: ' + deal.promoCode : '';
  const discountLine = deal.discount ? ' (' + deal.discount + '% off)' : '';
  const caption = '🔥 New Deal Alert!\n\n' + storeIcon + ' ' + storeName + '\n\n' +
    '📦 ' + (deal.title || storeName + ' Deal') + '\n\n' +
    '💰 ' + (deal.price || 'Check link') + discountLine + codeLine + '\n\n' +
    '👉 ' + deal.url;
  const safeCaption = caption.length > 1024 ? caption.substring(0, 1021) + '...' : caption;

  try {
    if (deal.imageUrl) {
      const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendPhoto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo: deal.imageUrl, caption: safeCaption }),
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('Telegram sendPhoto failed:', JSON.stringify(data));
        return false;
      }
    } else {
      console.log('No image for deal, skipping Telegram post:', deal.url);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Telegram post failed:', e.message);
    return false;
  }
}

async function postToFacebook(deal) {
  const pageToken = process.env.FACEBOOK_PAGE_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!pageToken || !pageId) return false;

  const storeIcon = deal.store === 'walmart' ? '🛒' : '🛍️';
  const storeName = deal.store === 'walmart' ? 'Walmart.com' : 'Amazon.com';
  const codeLine = deal.promoCode ? '\n🏷 Code: ' + deal.promoCode : '';
  const discountLine = deal.discount ? ' (' + deal.discount + '% off)' : '';
  const message = '🔥 New Deal Alert!\n\n' + storeIcon + ' ' + storeName + '\n\n' +
    '📦 ' + (deal.title || storeName + ' Deal') + '\n\n' +
    '💰 ' + (deal.price || 'Check link') + discountLine + codeLine + '\n\n' +
    '👉 ' + deal.url;

  try {
    if (deal.imageUrl) {
      const res = await fetch('https://graph.facebook.com/v19.0/' + pageId + '/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: deal.imageUrl, caption: message, access_token: pageToken }),
      });
      const data = await res.json();
      if (data.error) {
        await fetch('https://graph.facebook.com/v19.0/' + pageId + '/feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, link: deal.url, access_token: pageToken }),
        });
      }
    } else {
      return false;
    }
    return true;
  } catch (e) {
    console.error('Facebook post failed:', e.message);
    return false;
  }
}

// Clean title: strip "Amazon.com:" prefix and decode HTML entities
function cleanTitle(title) {
  if (!title) return null;
  const cleaned = title
    .replace(/^Amazon\.com\s*[:\-]\s*/i, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

// Validate deal fields — must have real title, URL, and price/discount before posting
function isValidDeal(deal) {
  const raw = (deal.title || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return { valid: false, reason: 'SKIPPED: Product title not found' };
  if (lower === 'amazon.com') return { valid: false, reason: 'SKIPPED: Title is only "Amazon.com"' };
  if (lower === 'message not delivered') return { valid: false, reason: 'SKIPPED: Email error — title is "Message not delivered"' };
  if (lower === 'amazon deal') return { valid: false, reason: 'SKIPPED: Generic fallback title with no real product info' };
  if (!deal.url) return { valid: false, reason: 'SKIPPED: No Amazon URL found' };
  if (!deal.price && !deal.discount) return { valid: false, reason: 'SKIPPED: No price or discount percentage found' };
  return { valid: true };
}

export default async (req, context) => {
  const queueStore = getStore("deal-queue");
  const submissionsStore = getStore("submissions");

  let queue = [];
  try { queue = await queueStore.get('queue', { type: 'json' }) || []; } catch (e) { queue = []; }

  if (queue.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'Queue is empty' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const deal = queue.shift();

  if (deal.store === 'amazon' && deal.asin) {
    const scraped = await getAmazonImage(deal.asin);
    if (scraped) {
      deal.title = scraped.title || deal.title;
      deal.price = deal.price || scraped.price;
      if (scraped.image) {
        const r2Url = await fetchAndUploadImage(scraped.image, deal.asin);
        deal.imageUrl = r2Url || scraped.image;
      }
    }
  }

  // If no image found, put deal back at front of queue and skip for now
  if (!deal.imageUrl) {
    console.log('No image found for deal, requeueing:', deal.url);
    queue.unshift(deal);
    await queueStore.setJSON('queue', queue);
    return new Response(JSON.stringify({
      success: true,
      message: 'No image found, deal requeued',
      url: deal.url,
      queueRemaining: queue.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // Clean deal title before validation and posting
  deal.title = cleanTitle(deal.title);

  // Validate — skip and log if deal does not meet minimum requirements
  const validation = isValidDeal(deal);
  if (!validation.valid) {
    console.log('[post-queued-deal]', validation.reason, '| URL:', deal.url);
    await queueStore.setJSON('queue', queue);
    return new Response(JSON.stringify({
      success: true,
      skipped: true,
      reason: validation.reason,
      queueRemaining: queue.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const telegramOk = await postToTelegram(deal);
  const facebookOk = await postToFacebook(deal);

  // Only save to submissions if posted successfully
  if (telegramOk) {
    const submission = {
      id: deal.id,
      asin: deal.asin || null,
      title: deal.title,
      price: deal.price || null,
      originalPrice: deal.originalPrice || null,
      discountPercent: deal.discount ? parseInt(deal.discount) : null,
      url: deal.url,
      image: deal.imageUrl || null,
      discountCode: deal.promoCode || null,
      source: 'email',
      store: deal.store || 'amazon',
      status: 'approved',
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await submissionsStore.setJSON(deal.id, submission);

    let index = [];
    try { index = await submissionsStore.get('index', { type: 'json' }) || []; } catch (e) { index = []; }
    index.unshift(deal.id);
    await submissionsStore.setJSON('index', index);
  }

  await queueStore.setJSON('queue', queue);

  return new Response(JSON.stringify({
    success: true,
    posted: deal.title,
    imageUrl: deal.imageUrl,
    telegramOk,
    facebookOk,
    queueRemaining: queue.length,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '*/5 * * * *',
};
