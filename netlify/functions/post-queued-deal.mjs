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
  // Try scraping first
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

  // Fallback: use Amazon widget image URL
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
      const msgRes = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: safeCaption }),
      });
      const msgData = await msgRes.json();
      if (!msgData.ok) {
        console.error('Telegram sendMessage failed:', JSON.stringify(msgData));
        return false;
      }
    }    return true;
  } catch (e) {
    console.error('Telegram post failed:', e.message);
    return false;
  }
}

async function postToFacebook(deal) {
  const pageToken = process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
  const pageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  if (!pageToken || !pageId) return { ok: false, error: 'Missing FB credentials' };

  const storeIcon = deal.store === 'walmart' ? '\u{1F6D2}' : '\u{1F6CD}\uFE0F';
  const storeName = deal.store === 'walmart' ? 'Walmart.com' : 'Amazon.com';
  const codeLine = deal.promoCode ? '\n\u{1F3F7} Code: ' + deal.promoCode : '';
  const discountLine = deal.discount ? ' (' + deal.discount + '% off)' : '';
  const message = '\u{1F525} New Deal Alert!\n\n' + storeIcon + ' ' + storeName + '\n\n' +
    '\u{1F4E6} ' + (deal.title || storeName + ' Deal') + '\n\n' +
    '\u{1F4B0} ' + (deal.price || 'Check link') + discountLine + codeLine + '\n\n' +
    '\u{1F449} ' + deal.url;

  try {
    if (deal.imageUrl) {
      const tok = pageToken;
      const pid = pageId;
      const photoRes = await fetch('https://graph.facebook.com/v19.0/' + pid + '/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: deal.imageUrl, caption: message, access_token: tok }),
      });
      const photoData = await photoRes.json();
      if (photoData.id) return { ok: true, postId: photoData.id };
      const feedRes = await fetch('https://graph.facebook.com/v19.0/' + pid + '/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, link: deal.url, access_token: tok }),
      });
      const feedData = await feedRes.json();
      if (feedData.id) return { ok: true, postId: feedData.id, via: 'feed' };
      return { ok: false, error: feedData.error?.message || photoData.error?.message || 'API error' };
    }
    // No image — try text-only feed post
    const tok = pageToken;
    const pid = pageId;
    const noImgRes = await fetch('https://graph.facebook.com/v19.0/' + pid + '/feed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, link: deal.url, access_token: tok }),
    });
    const noImgData = await noImgRes.json();
    if (noImgData.id) return { ok: true, postId: noImgData.id, via: 'feed-text' };
    return { ok: false, error: noImgData.error?.message || 'FB API error' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
        // Try to upload to R2 first for reliable delivery
        const r2Url = await fetchAndUploadImage(scraped.image, deal.asin);
        deal.imageUrl = r2Url || scraped.image;
      }
    }
  }

  // If no image found, put deal back at front of queue and skip for now
  const telegramOk = await postToTelegram(deal);
  const fbResult = await postToFacebook(deal);
  const facebookOk = fbResult?.ok === true;
  const facebookError = fbResult?.ok ? null : (fbResult?.error || 'Unknown error');
  const facebookPostId = fbResult?.postId || null;

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
      postedToFacebook: facebookOk,
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await submissionsStore.setJSON(deal.id, submission);

    let index = [];
    try { index = await submissionsStore.get('index', { type: 'json' }) || []; } catch (e) { index = []; }
    index.unshift(deal.id);
    await submissionsStore.setJSON('index', index);
  // Keep telegram-posted dedup store in sync so post-deals-to-telegram.mjs doesn't repost this deal
  try {
    const postedStore = getStore("telegram-posted");
    let postedIds = [];
    try {
      const postedData = await postedStore.get("posted-ids", { type: "json" });
      if (postedData && Array.isArray(postedData)) postedIds = postedData;
    } catch (e) {}
    postedIds.push(deal.id);
    if (postedIds.length > 500) postedIds = postedIds.slice(-500);
    await postedStore.set("posted-ids", JSON.stringify(postedIds));
  } catch (e) {
    console.error("Failed to sync telegram-posted store:", e.message);
  }
  }

  await queueStore.setJSON('queue', queue);

  return new Response(JSON.stringify({
    success: true,
    posted: deal.title,
    imageUrl: deal.imageUrl,
    telegramOk,
    facebookOk,
  facebookError,
    facebookPostId,
    queueRemaining: queue.length,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '*/5 * * * *',
};
