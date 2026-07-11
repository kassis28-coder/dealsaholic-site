import { getStore } from "@netlify/blobs";

// ─── Facebook Graph API version ────────────────────────────────────────────
const FB_API_VERSION = 'v21.0';

// ============================================================
// CRYPTO HELPERS FOR R2 UPLOADS
// ============================================================

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

// ============================================================
// R2 / IMAGE HELPERS
// ============================================================

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

// FIX: Multi-method image scraping so deals are not stuck requeueing forever.
// Methods tried in order:
//   1. Direct SSL image URL — fast, no HTML parsing needed
//   2. Amazon ad-system widget — follows redirect to real image CDN URL
//   3. Scrape og:image / hiRes from the product page HTML
async function getAmazonImage(asin) {
  // Method 1: Direct image URL pattern (works for most ASINs without scraping)
  const directUrl = `https://images-na.ssl-images-amazon.com/images/P/${asin}.01._SL300_.jpg`;
  try {
    const testRes = await fetch(directUrl, { method: 'HEAD' });
    const ct = testRes.headers.get('content-type') || '';
    if (testRes.ok && ct.startsWith('image/')) {
      console.log(`[getAmazonImage] Method 1 (direct SSL) succeeded for ${asin}`);
      return { title: null, price: null, image: directUrl };
    }
  } catch (e) {
    console.error('[getAmazonImage] Method 1 failed:', e.message);
  }

  // Method 2: Amazon ad widget — redirects to actual product image on CDN
  const widgetUrl = `https://ws-na.amazon-adsystem.com/widgets/q?_encoding=UTF8&ASIN=${asin}&Format=_SL250_&ID=AsinImage&MarketPlace=US&ServiceVersion=20070822&WS=1`;
  try {
    const widgetRes = await fetch(widgetUrl, { redirect: 'follow' });
    const ct = widgetRes.headers.get('content-type') || '';
    if (widgetRes.ok && ct.startsWith('image/')) {
      console.log(`[getAmazonImage] Method 2 (ad widget) succeeded for ${asin}: ${widgetRes.url}`);
      return { title: null, price: null, image: widgetRes.url };
    }
  } catch (e) {
    console.error('[getAmazonImage] Method 2 failed:', e.message);
  }

  // Method 3: Scrape product page HTML
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
      if (image) {
        console.log(`[getAmazonImage] Method 3 (scrape) succeeded for ${asin}`);
        return { title, price, image };
      }
    }
  } catch (e) {
    console.error('[getAmazonImage] Method 3 failed:', e.message);
  }

  console.error(`[getAmazonImage] All methods failed for ASIN ${asin}`);
  return null;
}

// ============================================================
// SOCIAL POSTING
// FIX: All emojis removed — they corrupt on Facebook/Telegram UTF-8 pipeline
// ============================================================

async function postToTelegram(deal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('[Telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return false;
  }

  const storeName = deal.store === 'walmart' ? 'Walmart.com' : 'Amazon.com';
  const codeLine = deal.promoCode ? '\nCode: ' + deal.promoCode : '';
  const discountLine = deal.discount ? ' (' + deal.discount + '% off)' : '';
  const caption = '<b>New Deal Alert!</b>\n\n' + storeName + '\n\n' +
    '<b>' + (deal.title || storeName + ' Deal') + '</b>\n\n' +
    'Price: <b>' + (deal.price || 'Check link') + '</b>' + discountLine + codeLine + '\n\n' +
    '<a href="' + deal.url + '">Grab this deal!</a>';
  const safeCaption = caption.length > 1024 ? caption.substring(0, 1021) + '...' : caption;

  try {
    // Try sendPhoto first (only if image available)
    if (deal.imageUrl) {
      const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendPhoto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo: deal.imageUrl, caption: safeCaption, parse_mode: 'HTML' }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log('[Telegram] sendPhoto succeeded');
        return true;
      }
      console.error('[Telegram] sendPhoto failed:', JSON.stringify(data), '— falling back to sendMessage');
    }

    // Fallback: send as HTML message (works even when image URL is inaccessible)
    const msgRes = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: safeCaption, parse_mode: 'HTML' }),
    });
    const msgData = await msgRes.json();
    if (msgData.ok) {
      console.log('[Telegram] sendMessage fallback succeeded');
      return true;
    }
    console.error('[Telegram] sendMessage also failed:', JSON.stringify(msgData));
    return false;
  } catch (e) {
    console.error('[Telegram] post failed:', e.message);
    return false;
  }
}

async function postToFacebook(deal) {
  const pageToken = process.env.FACEBOOK_PAGE_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!pageToken || !pageId) {
    console.error('[Facebook] Missing FACEBOOK_PAGE_TOKEN or FACEBOOK_PAGE_ID');
    return false;
  }

  const storeName = deal.store === 'walmart' ? 'Walmart.com' : 'Amazon.com';
  const codeLine = deal.promoCode ? '\nCode: ' + deal.promoCode : '';
  const discountLine = deal.discount ? ' (' + deal.discount + '% off)' : '';
  const message = 'New Deal Alert!\n\n' + storeName + '\n\n' +
    (deal.title || storeName + ' Deal') + '\n\n' +
    'Price: ' + (deal.price || 'Check link') + discountLine + codeLine + '\n\n' +
    'Shop now: ' + deal.url + '\n\n#ad #deals #amazon #dealsaholic #shopping #sale';

  try {
    // Try photo post first (only if image available)
    if (deal.imageUrl) {
      const photoRes = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: deal.imageUrl, caption: message, access_token: pageToken }),
      });
      const photoData = await photoRes.json();
      if (!photoData.error) {
        console.log('[Facebook] photo post succeeded, id:', photoData.id);
        return true;
      }
      console.error('[Facebook] /photos failed:', JSON.stringify(photoData.error), '— falling back to /feed');
    }

    // Fallback: text post with link
    const feedRes = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${pageId}/feed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, link: deal.url, access_token: pageToken }),
    });
    const feedData = await feedRes.json();
    if (!feedData.error) {
      console.log('[Facebook] /feed fallback succeeded, id:', feedData.id);
      return true;
    }
    console.error('[Facebook] /feed also failed:', JSON.stringify(feedData.error));
    return false;
  } catch (e) {
    console.error('[Facebook] post failed:', e.message);
    return false;
  }
}

// ============================================================
// TITLE / VALIDATION HELPERS
// ============================================================

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

// ============================================================
// DEDUPLICATION HELPERS
// ============================================================

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return url.toLowerCase().trim();
  }
}

async function loadDedupIndexes(submissionsStore) {
  let asinIndex = {};
  let urlIndex = {};
  try { asinIndex = await submissionsStore.get('asin-index', { type: 'json' }) || {}; } catch {}
  try { urlIndex = await submissionsStore.get('url-index', { type: 'json' }) || {}; } catch {}
  return { asinIndex, urlIndex };
}

async function saveDedupIndexes(submissionsStore, asinIndex, urlIndex) {
  await submissionsStore.setJSON('asin-index', asinIndex);
  await submissionsStore.setJSON('url-index', urlIndex);
}

async function findDuplicateDeal(submissionsStore, deal, asinIndex, urlIndex) {
  if (deal.asin && asinIndex[deal.asin]) {
    const dealId = asinIndex[deal.asin];
    try {
      const existing = await submissionsStore.get(dealId, { type: 'json' });
      if (existing) return { found: true, reason: 'ASIN', dealId, existingDeal: existing };
    } catch {}
    delete asinIndex[deal.asin];
  }

  const normUrl = normalizeUrl(deal.url);
  if (normUrl && urlIndex[normUrl]) {
    const dealId = urlIndex[normUrl];
    try {
      const existing = await submissionsStore.get(dealId, { type: 'json' });
      if (existing) return { found: true, reason: 'URL', dealId, existingDeal: existing };
    } catch {}
    delete urlIndex[normUrl];
  }

  return { found: false };
}

function shouldUpdateDeal(existingDeal, newDeal) {
  const updates = {};
  let changed = false;

  if (newDeal.price && newDeal.price !== existingDeal.price) {
    updates.price = newDeal.price;
    changed = true;
  }
  if (newDeal.imageUrl && !existingDeal.image) {
    updates.image = newDeal.imageUrl;
    changed = true;
  }
  if (newDeal.discount && !existingDeal.discountPercent) {
    updates.discountPercent = parseInt(newDeal.discount);
    changed = true;
  }
  if (newDeal.promoCode && !existingDeal.discountCode) {
    updates.discountCode = newDeal.promoCode;
    changed = true;
  }
  if (changed) {
    updates.updatedAt = new Date().toISOString();
    updates.expiresOn = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  const createdAt = new Date(existingDeal.createdAt).getTime();
  const isRecent = createdAt > Date.now() - 30 * 24 * 60 * 60 * 1000;

  return { shouldUpdate: changed, isRecent, updates };
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async (req, context) => {
  const queueStore = getStore("deal-queue");
  const submissionsStore = getStore("submissions");

  let queue = [];
  try { queue = await queueStore.get('queue', { type: 'json' }) || []; } catch { queue = []; }

  if (queue.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'Queue is empty' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // Pull the next deal — keep a reference so we can re-add it on failure
  const deal = queue.shift();

  // ── Re-fetch image from Amazon using 3-method scraper ───────────────────────
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

  // ── No image after all scraping attempts — requeue with retry counter ────────
  // Max 5 retries then drop to prevent infinite loop. Each retry is ~5min apart.
  if (!deal.imageUrl) {
    const retries = (deal.imageRetries || 0) + 1;
    const maxRetries = 5;
    if (retries >= maxRetries) {
      console.log(`[post-queued-deal] No image after ${retries} attempts — dropping deal:`, deal.url);
      await queueStore.setJSON('queue', queue);
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: `No image after ${maxRetries} scraping attempts`,
        url: deal.url,
        queueRemaining: queue.length,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    console.log(`[post-queued-deal] No image (attempt ${retries}/${maxRetries}) — requeueing:`, deal.url);
    queue.unshift({ ...deal, imageRetries: retries });
    await queueStore.setJSON('queue', queue);
    return new Response(JSON.stringify({
      success: true,
      message: `No image found, deal requeued (attempt ${retries}/${maxRetries})`,
      url: deal.url,
      queueRemaining: queue.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  deal.title = cleanTitle(deal.title);

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

  // ── DEDUPLICATION CHECK ──────────────────────────────────────────────────────
  const { asinIndex, urlIndex } = await loadDedupIndexes(submissionsStore);
  const dupCheck = await findDuplicateDeal(submissionsStore, deal, asinIndex, urlIndex);

  if (dupCheck.found) {
    const { dealId, existingDeal, reason } = dupCheck;
    const { shouldUpdate, isRecent, updates } = shouldUpdateDeal(existingDeal, deal);

    if (shouldUpdate) {
      const updatedDeal = { ...existingDeal, ...updates };
      await submissionsStore.setJSON(dealId, updatedDeal);
      await saveDedupIndexes(submissionsStore, asinIndex, urlIndex);
      console.log(`[post-queued-deal] UPDATED EXISTING DEAL | Same ${reason} | ASIN: ${deal.asin || 'N/A'} | ID: ${dealId}`);
      await queueStore.setJSON('queue', queue);
      return new Response(JSON.stringify({
        success: true, updated: true,
        reason: `Updated existing deal (same ${reason})`,
        dealId, queueRemaining: queue.length,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    console.log(`[post-queued-deal] SKIPPED DUPLICATE | ${reason} | ASIN: ${deal.asin || 'N/A'} | ID: ${dealId}`);
    await saveDedupIndexes(submissionsStore, asinIndex, urlIndex);
    await queueStore.setJSON('queue', queue);
    return new Response(JSON.stringify({
      success: true, skipped: true,
      reason: `Duplicate ${reason} — deal already exists`,
      dealId, queueRemaining: queue.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  // ── END DEDUPLICATION ────────────────────────────────────────────────────────

  const telegramOk = await postToTelegram(deal);
  const facebookOk = await postToFacebook(deal);

  // ── FIX: Re-add to queue if BOTH platforms failed — don't silently lose deals ─
  if (!telegramOk && !facebookOk) {
    console.error('[post-queued-deal] Both Telegram and Facebook failed — requeueing deal:', deal.url);
    queue.unshift(deal);
    await queueStore.setJSON('queue', queue);
    return new Response(JSON.stringify({
      success: false,
      message: 'Both platforms failed — deal requeued',
      url: deal.url,
      queueRemaining: queue.length,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // At least one platform succeeded — save the deal as posted
  if (telegramOk || facebookOk) {
    const submission = {
      id: deal.id,
      asin: deal.asin || null,
      title: deal.title,
      price: deal.price || null,
      originalPrice: deal.originalPrice || null,
      discountPercent: deal.discount ? parseInt(deal.discount) : null,
      url: deal.url,
      image: deal.imageUrl || null,
      imageUrl: deal.imageUrl || null,
      discountCode: deal.promoCode || null,
      source: 'email',
      store: deal.store || 'amazon',
      status: 'approved',
      sponsored: false,
      postedToTelegram: telegramOk,
      postedToFacebook: facebookOk,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await submissionsStore.setJSON(deal.id, submission);

    let index = [];
    try { index = await submissionsStore.get('index', { type: 'json' }) || []; } catch { index = []; }
    index.unshift(deal.id);
    await submissionsStore.setJSON('index', index);

    if (deal.asin) asinIndex[deal.asin] = deal.id;
    const normUrl = normalizeUrl(deal.url);
    if (normUrl) urlIndex[normUrl] = deal.id;
    await saveDedupIndexes(submissionsStore, asinIndex, urlIndex);
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
