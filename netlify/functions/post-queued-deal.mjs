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
// 1. Direct SSL image URL — fast, no HTML parsing needed
// 2. Amazon ad-system widget — follows redirect to real image CDN URL
// 3. Scrape og:image / hiRes from the product page HTML
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
// STYLED DEAL CARD (SVG template → PNG via sharp → R2)
// Generates the Instagram-style 1080×1350 deal card image.
// Template: pink bg, white card, DEAL OF THE DAY header, red title
// banner, product photo (left), ONLY $price (right), code, % OFF badge,
// @Deals_aholic watermark. Used for Instagram; Telegram/Facebook keep
// using the plain product image so existing posts are unaffected.
// ============================================================

function escapeXml(s) {
return (s || '')
.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function wrapText(text, maxCharsPerLine) {
const words = (text || '').split(' ');
const lines = [];
let current = '';
for (const word of words) {
const candidate = current ? `${current} ${word}` : word;
if (candidate.length > maxCharsPerLine && current) {
lines.push(current);
current = word;
} else {
current = candidate;
}
}
if (current) lines.push(current);
return lines.slice(0, 4);
}

// Returns the SVG string + product placeholder coordinates.
// The product image is NOT embedded — it is composited by sharp afterwards
// so the SVG stays small and renders reliably on all environments.
function buildDealSvg(deal) {
const W = 1080, H = 1350, P = 35;

const titleLines = wrapText(deal.title || 'Amazon Deal', 38);
const tLineH = 50;
const tBanH = Math.max(105, titleLines.length * tLineH + 35);

const headerY = 75, headerH = 100;
const titleY = headerY + headerH;  // 175
const productY = titleY + tBanH + 15;
const productX = P + 12;           // 47
const productW = 510, productH = 490;
const bottomY = productY + productH + 20;
const priceX = 820;
const hasCode = !!deal.promoCode;
const hasDiscount = !!deal.discount;

const titleTspans = titleLines.map((line, i) =>
`<tspan x="540" dy="${i === 0 ? 0 : tLineH}">${escapeXml(line)}</tspan>`
).join('');

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#f8d7ca"/>
      <stop offset="50%" style="stop-color:#f0b9a8"/>
      <stop offset="100%" style="stop-color:#e8a090"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="${P}" y="${P}" width="${W - P * 2}" height="${H - P * 2}" rx="22" fill="white"/>
  <rect x="${P}" y="${headerY}" width="${W - P * 2}" height="${headerH}" fill="#f2f2f2"/>
  <text x="${W / 2}" y="${headerY + Math.floor(headerH / 2) + 2}"
    text-anchor="middle" dominant-baseline="central"
    font-size="50" font-weight="bold"
    font-family="Liberation Sans,Arial,Helvetica,sans-serif" fill="#2d2d2d"
  >&#x1F525; DEAL OF THE DAY &#x1F525;</text>
  <rect x="${P}" y="${titleY}" width="${W - P * 2}" height="${tBanH}" fill="#CC0000"/>
  <text x="540" y="${titleY + 28}"
    text-anchor="middle" dominant-baseline="hanging"
    font-size="38" font-weight="bold"
    font-family="Liberation Sans,Arial,Helvetica,sans-serif" fill="white"
  >${titleTspans}</text>
  <rect x="${productX}" y="${productY}" width="${productW}" height="${productH}" rx="10" fill="#f5f5f5"/>
  ${deal.price ? `
  <text x="${priceX}" y="${productY + 170}"
    text-anchor="middle" dominant-baseline="central"
    font-size="48" font-weight="bold"
    font-family="Liberation Sans,Arial,Helvetica,sans-serif" fill="#1a1a1a">ONLY</text>
  <text x="${priceX}" y="${productY + 275}"
    text-anchor="middle" dominant-baseline="central"
    font-size="76" font-weight="bold"
    font-family="Liberation Sans,Arial,Helvetica,sans-serif" fill="#1a1a1a">${escapeXml(deal.price)}</text>
  ${deal.originalPrice ? `<text x="${priceX}" y="${productY + 348}"
    text-anchor="middle" dominant-baseline="central"
    font-size="30" font-family="Liberation Sans,Arial,Helvetica,sans-serif" fill="#aaaaaa"
  >Reg ${escapeXml(deal.originalPrice)}</text>` : ''}
  ` : ''}
  ${hasCode ? `
  <text x="${P + 20}" y="${bottomY + 55}"
    dominant-baseline="central"
    font-size="50" font-weight="bold"
    font-family="Liberation Sans,Arial,Helvetica,sans-serif" fill="#1a1a1a"
  >Code: ${escapeXml(deal.promoCode)}</text>
  ` : ''}
  ${hasDiscount ? `
  <rect x="${P}" y="${bottomY + (hasCode ? 90 : 18)}" width="680" height="88" rx="10" fill="#CC0000"/>
  <text x="${P + 340}" y="${bottomY + (hasCode ? 134 : 62)}"
    text-anchor="middle" dominant-baseline="central"
    font-size="58" font-weight="bold"
    font-family="Liberation Sans,Arial,Helvetica,sans-serif" fill="white"
  >${escapeXml(String(deal.discount))}% OFF</text>
  ` : ''}
  <rect x="698" y="${H - P - 64}" width="348" height="46" rx="23" fill="#e8a090" opacity="0.85"/>
  <text x="872" y="${H - P - 41}"
    text-anchor="middle" dominant-baseline="central"
    font-size="25" font-family="Liberation Serif,Georgia,serif" font-style="italic" fill="#5c3020"
  >@Deals_aholic</text>
</svg>`;

return { svg, productX, productY, productW, productH };
}

async function generateStyledImage(deal) {
if (!deal.imageUrl) return null;
try {
const { default: sharp } = await import('sharp');

// 1. Render SVG template to PNG (product area is a flat placeholder rect)
const { svg, productX, productY, productW, productH } = buildDealSvg(deal);
const templatePng = await sharp(Buffer.from(svg)).png().toBuffer();

// 2. Fetch product image
const imgRes = await fetch(deal.imageUrl, {
headers: {
'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
'Referer': 'https://www.amazon.com/',
},
});
if (!imgRes.ok) return null;
const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

// 3. Resize product image to fit inside placeholder (maintain aspect ratio)
const productImgResized = await sharp(imgBuffer)
.resize(productW, productH, { fit: 'inside', withoutEnlargement: false })
.png()
.toBuffer();

const pMeta = await sharp(productImgResized).metadata();
const pW = pMeta.width, pH = pMeta.height;

// 4. Center the resized image on a filled background the same size as the placeholder
const productImgFull = await sharp({
create: { width: productW, height: productH, channels: 4, background: { r: 245, g: 245, b: 245, alpha: 255 } },
})
.composite([{ input: productImgResized, left: Math.floor((productW - pW) / 2), top: Math.floor((productH - pH) / 2) }])
.png()
.toBuffer();

// 5. Apply rounded corners (rx=10 matches SVG placeholder) via dest-in mask
const maskSvg = `<svg width="${productW}" height="${productH}"><rect width="${productW}" height="${productH}" rx="10" ry="10" fill="white"/></svg>`;
const productImgRounded = await sharp(productImgFull)
.composite([{ input: Buffer.from(maskSvg), blend: 'dest-in' }])
.png()
.toBuffer();

// 6. Composite the rounded product image onto the template
const finalPng = await sharp(templatePng)
.composite([{ input: productImgRounded, left: productX, top: productY }])
.png()
.toBuffer();

// 7. Upload to R2
const filename = `deals/styled-${deal.id || Date.now()}.png`;
const r2Url = await uploadToR2(finalPng, 'image/png', filename);
console.log('[STYLED-IMAGE]', r2Url ? `uploaded → ${r2Url}` : 'R2 upload failed');
return r2Url;
} catch (e) {
console.error('[STYLED-IMAGE] generateStyledImage failed:', e.message);
return null;
}
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

// ── INSTAGRAM POSTING ─────────────────────────────────────────────────────────
// Uses the styled deal card image (deal.styledImageUrl) when available,
// falls back to the plain product image. Requires two env vars:
//   INSTAGRAM_BUSINESS_ACCOUNT_ID — your IG Business Account ID
//   FACEBOOK_PAGE_TOKEN           — same token used for Facebook (reused)
// If INSTAGRAM_BUSINESS_ACCOUNT_ID is not set, this is a silent no-op.

async function postToInstagram(deal) {
const igUserId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const pageToken = process.env.FACEBOOK_PAGE_TOKEN;
if (!igUserId || !pageToken) {
console.log('[INSTAGRAM] Skipped: INSTAGRAM_BUSINESS_ACCOUNT_ID not configured');
return false;
}
const imageUrl = deal.styledImageUrl || deal.imageUrl;
if (!imageUrl) { console.log('[INSTAGRAM] No image, skipping'); return false; }

const codeLine = deal.promoCode ? `\n🏷️ Code: ${deal.promoCode}` : '';
const discountLine = deal.discount ? ` (${deal.discount}% off)` : '';
const caption =
`🔥 DEAL OF THE DAY!\n\n` +
`📦 ${deal.title || 'Amazon Deal'}\n\n` +
`💰 ${deal.price || 'Check link'}${discountLine}${codeLine}\n\n` +
`🔗 Link in bio!\n\n` +
`#deals #dealsaholic #amazon #sale #discount #shopping #amazonfind #amazondeal`;

try {
// Step 1: Create media container
const createRes = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${igUserId}/media`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ image_url: imageUrl, caption, access_token: pageToken }),
});
const createData = await createRes.json();
console.log('[INSTAGRAM] media create:', JSON.stringify(createData));
if (!createData.id) {
console.error('[INSTAGRAM] create failed:', createData.error?.message);
return false;
}

// Step 2: Publish the container
const pubRes = await fetch(`https://graph.facebook.com/${FB_API_VERSION}/${igUserId}/media_publish`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ creation_id: createData.id, access_token: pageToken }),
});
const pubData = await pubRes.json();
console.log('[INSTAGRAM] publish:', JSON.stringify(pubData));
if (pubData.error) {
console.error('[INSTAGRAM] publish failed:', pubData.error.message);
return false;
}
return true;
} catch (e) {
console.error('[INSTAGRAM] post failed:', e.message);
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

// ─── Distributed lock ────────────────────────────────────────────────────────
// Prevents two concurrent Netlify invocations from processing the same queue item.
// Netlify Blobs has no atomic compare-and-swap, so we use write-wait-verify:
//   1. If a recent lock exists, another instance is running — bail immediately.
//   2. Write our lock with a unique ID.
//   3. Wait 600 ms so any simultaneously-starting instance also writes its lock.
//   4. Re-read: if our ID is still there, we own the lock. Otherwise bail.
// This shrinks the duplicate window from "every concurrent pair" to near zero.
const LOCK_KEY = 'processing-lock';
const LOCK_TTL_MS = 90_000; // 90 s — longer than the worst-case function run

const nowMs = Date.now();
let existingLock = null;
try { existingLock = await queueStore.get(LOCK_KEY, { type: 'json' }); } catch {}
if (existingLock && (nowMs - existingLock.ts) < LOCK_TTL_MS) {
  console.log('[post-queued-deal] Lock held (age ' + (nowMs - existingLock.ts) + ' ms) — skipping.');
  return new Response(JSON.stringify({ success: true, message: 'Another instance is processing' }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}

const lockId = Math.random().toString(36).slice(2) + nowMs;
await queueStore.setJSON(LOCK_KEY, { ts: nowMs, id: lockId });
await new Promise(r => setTimeout(r, 600));

let wonLock = null;
try { wonLock = await queueStore.get(LOCK_KEY, { type: 'json' }); } catch {}
if (!wonLock || wonLock.id !== lockId) {
  console.log('[post-queued-deal] Lost lock race — another instance is processing.');
  return new Response(JSON.stringify({ success: true, message: 'Lost lock race' }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
// ─── Lock acquired ───────────────────────────────────────────────────────────

try {

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
// Max 5 retries then drop to prevent infinite loop. Each retry is ~10min apart.
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

// ── Generate styled deal card (1080×1350 PNG matching @Deals_aholic template)
// Stored in R2 and used for Instagram. Telegram/Facebook continue using
// deal.imageUrl (plain product image) — no change to their existing behaviour.
const styledImageUrl = await generateStyledImage(deal);
if (styledImageUrl) deal.styledImageUrl = styledImageUrl;

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

// ── DEDUPLICATION CHECK ──────────────────────────────────
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
// Instagram uses the styled card image (plain product image as fallback)
const instagramOk = await postToInstagram(deal);

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
styledImage: deal.styledImageUrl || null,
discountCode: deal.promoCode || null,
source: 'email',
store: deal.store || 'amazon',
status: 'approved',
sponsored: false,
postedToTelegram: telegramOk,
postedToFacebook: facebookOk,
postedToInstagram: instagramOk,
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
styledImageUrl: deal.styledImageUrl || null,
telegramOk,
facebookOk,
instagramOk,
queueRemaining: queue.length,
}), { status: 200, headers: { 'Content-Type': 'application/json' } });

} finally {
  // Always release the lock so the next scheduled run can proceed
  try { await queueStore.delete(LOCK_KEY); } catch {}
}
};

// Schedule disabled — social posting now handled by post-to-facebook.mjs and post-deals-to-telegram.mjs
// export const config = { schedule: '*/10 * * * *' };

mjs
// export const config = { schedule: '*/10 * * * *' };

