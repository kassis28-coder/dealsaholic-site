import { getStore } from "@netlify/blobs";

async function followRedirectForAsin(amazonUrl) {try {const res = await fetch(amazonUrl, {method: 'HEAD',redirect: 'follow',headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },});const finalUrl = res.url || amazonUrl;const asin = finalUrl.match(//dp/([A-Z0-9]{10})/i)?.[1] || null;return { asin, finalUrl };} catch (e) {return { asin: null, finalUrl: amazonUrl };}}

async function fetchAmazonMeta(amazonUrl) {const { asin: asinFromRedirect, finalUrl: redirectUrl } = await followRedirectForAsin(amazonUrl);try {const res = await fetch(amazonUrl, {headers: {'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)','Accept-Language': 'en-US,en;q=0.9','Accept': 'text/html,application/xhtml+xml',},redirect: 'follow',});if (!res.ok) {if (!asinFromRedirect) return null;return {title: null, price: null, originalPrice: null,image: https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg,asin: asinFromRedirect, finalUrl: redirectUrl,};}const finalUrl = res.url;const asin = finalUrl.match(//dp/([A-Z0-9]{10})/i)?.[1] || asinFromRedirect || null;const html = await res.text();

const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
  || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;

const image = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
  || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
  || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);

// Deal price (current selling price)
const priceMatch = html.match(/["']priceAmount["']\s*:\s*["']?([\d.]+)["']?/)
  || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;

// Original/list price (strikethrough on the page)
const origMatch = html.match(/class=["'][^"']*a-text-strike[^"']*["'][^>]*>[\s\S]{0,80}\$([\d,.]+)/i)
  || html.match(/["']listPrice["']\s*:\s*["']\$([\d,.]+)/i)
  || html.match(/class=["'][^"']*a-price\s+a-text-price[^"']*["'][^>]*>[\s\S]{0,80}\$([\d,.]+)/i);
const originalPrice = origMatch ? '$' + origMatch[1].replace(/,/g, '') : null;

return {
  title: title?.replace(/\s*[|:]\s*amazon\b.*/i, '').replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '').trim().substring(0, 150) || null,
  image, price, originalPrice, asin, finalUrl,
};

} catch (e) {if (!asinFromRedirect) return null;return {title: null, price: null, originalPrice: null,image: https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg,asin: asinFromRedirect, finalUrl: redirectUrl,};}}

function extractAmazonUrls(text) {const patterns = [/https?://(?.)?amazon.com/(?|gp/product)/[A-Z0-9]{10}[^\s"'<>]/gi,/https?://(?.)?amazon.com/(?|gc-apply|promotion)[/?][^\s"'<>]/gi,/https?://amzn.to/[A-Za-z0-9]+/gi,/https?://a.co/[A-Za-z0-9/]+/gi,];const urls = [];for (const pattern of patterns) {[...text.matchAll(new RegExp(pattern.source, 'gi'))].forEach(m => urls.push(m[0]));}return urls;}

function stripHtml(html) {return html.replace(/<style[^>]>[\s\S]?</style>/gi, '').replace(/<script[^>]>[\s\S]?</script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/'/g, "'").replace(/ /g, ' ').replace(/\s+/g, ' ').trim();}

// Returns true if the URL is a promo/coupon application link, not a product pagefunction isPromoOnlyUrl(url) {return //promocode/|/gc-apply/|/promotion//i.test(url)|| /amazon.com/coupons/i.test(url);}

// Extracts a promo code string from a promo URL path or query paramsfunction extractPromoCodeFromUrl(url) {const fromPath = url.match(//promocode/([A-Z0-9-]+)/i)?.[1];if (fromPath) return fromPath;try {const u = new URL(url);return u.searchParams.get('promo_code')|| u.searchParams.get('code')|| u.searchParams.get('coupon')|| null;} catch { return null; }}

// Strips email template label noise from a product titlefunction cleanTitle(title) {if (!title) return null;

// Remove common email field labelstitle = title.replace(/^\s*\d*\s*(?\sName|Product\sTitle|Deal\sTitle|Title|Product|Item|Name|Listing|Offer|Description)\s[:：-]\s*/i,'');

// Truncate at the first occurrence of any known stop markerconst stopIdx = title.search(/\b(?|Promo\sCode|Coupon\sCode|Discount\sCode|Deal\sPrice|Prime\sDeal\sPrice|Original\sPrice|List\sPrice|Price|Link|URL|ASIN|End\sDay|CC\sTime|CC\sID)\s:/i);if (stopIdx > 0) title = title.slice(0, stopIdx);

// Remove trailing bare promo codes (all-caps 4–20 char alphanumeric)title = title.replace(/\s+[A-Z0-9]{4,20}$/, '');

// Amazon suffix cleanuptitle = title.replace(/\s*[|:]\samazon\b./i, '').replace(/\s*-\samazon\b./i, '').trim();

return title.length > 3 ? title.substring(0, 150) : null;}

// Extracts deal price and original price from email plaintextfunction extractPricesFromText(text) {// Match "Deal price: $X" or "Prime Deal Price: $X" — colon required to prevent false positives.// (?\s+)? makes the "Prime " prefix optional so both labels are covered by one pattern.// If "Deal price: N/A" appears first the regex fails at that position and the engine// continues scanning, finding "Prime Deal Price: $X" further in the string.const dealMatch = text.match(/(?\s+)?deal\s+price\s*:\s*$?([\d,.]+)/i);// Match "Original price: $X" — colon required.const origMatch = text.match(/original\s+price\s*:\s*$?([\d,.]+)/i);

const dealPrice    = dealMatch ? '$' + parseFloat(dealMatch[1].replace(/,/g, '')).toFixed(2) : null;const originalPrice = origMatch ? '$' + parseFloat(origMatch[1].replace(/,/g, '')).toFixed(2) : null;

if (dealPrice || originalPrice) return { dealPrice, originalPrice };

// Fallback: collect all dollar amounts — lowest = deal, highest = originalconst allPrices = [...text.matchAll(/$([\d,.]+)/g)].map(m => parseFloat(m[1].replace(/,/g, ''))).filter(p => p >= 0.99 && p < 10000);

if (allPrices.length >= 2) {const sorted = [...new Set(allPrices)].sort((a, b) => a - b);// Only split into deal/original if there's a meaningful gap (>5%)if (sorted[sorted.length - 1] / sorted[0] > 1.05) {return {dealPrice:     '$' + sorted[0].toFixed(2),originalPrice: '$' + sorted[sorted.length - 1].toFixed(2),};}return { dealPrice: '$' + sorted[0].toFixed(2), originalPrice: null };}

return {dealPrice:     allPrices.length ? '$' + allPrices[0].toFixed(2) : null,originalPrice: null,};}

export default async (req, context) => {const urlObj = new URL(req.url);let emailBody = '', title = '', snippet = '';

if (req.method === 'GET') {emailBody = urlObj.searchParams.get('emailBody') || '';title     = urlObj.searchParams.get('title')     || '';snippet   = urlObj.searchParams.get('snippet')   || '';} else if (req.method === 'POST') {try { emailBody = await req.text(); } catch (e) { emailBody = ''; }}

const content = (emailBody || title).trim();

let claudeData = null;let rawSnippet = snippet;try {const parsed = JSON.parse(content);if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {if (parsed.title || parsed.amazonUrl) claudeData = parsed;if (parsed.snippet)      rawSnippet = parsed.snippet;if (parsed.emailSnippet) rawSnippet = rawSnippet || parsed.emailSnippet;// Handle GAS-style payload: { htmlBody, textBody, subject }if (parsed.htmlBody || parsed.html) emailBody = parsed.htmlBody || parsed.html;if (parsed.textBody || parsed.text) emailBody = emailBody || parsed.textBody || parsed.text;// Legacy: wrapped emailBodyif (parsed.emailBody) {emailBody = emailBody || parsed.emailBody;try {const inner = JSON.parse(parsed.emailBody);if (inner && typeof inner === 'object' && (inner.title || inner.amazonUrl)) claudeData = inner;} catch (e) {}}}} catch (e) {}

// After JSON unwrapping, emailBody now holds the actual HTML/text contentconst htmlContent = emailBody;const plainText   = stripHtml(htmlContent) || stripHtml(content);

const allUrls = [];if (claudeData?.amazonUrl) allUrls.push(claudeData.amazonUrl);extractAmazonUrls(htmlContent).forEach(u => allUrls.push(u));extractAmazonUrls(content).forEach(u => allUrls.push(u));extractAmazonUrls(plainText).forEach(u => allUrls.push(u));if (rawSnippet) {extractAmazonUrls(rawSnippet).forEach(u => allUrls.push(u));extractAmazonUrls(stripHtml(rawSnippet)).forEach(u => allUrls.push(u));}

const uniqueUrls = [...new Set(allUrls)];

// Separate product URLs from promo-only links (promocode, gc-apply, etc.)const promoUrls   = uniqueUrls.filter(u =>  isPromoOnlyUrl(u));const productUrls = uniqueUrls.filter(u => !isPromoOnlyUrl(u));

// Collect promo codes: promo URL paths first, then email textconst codesFromUrls = promoUrls.map(u => extractPromoCodeFromUrl(u)).filter(Boolean);const codeFromText =claudeData?.discountCode|| plainText.match(/(?\sCode|Coupon\sCode|Discount\sCode|Discount|Promo|Coupon|Code)\s[:：-]?\s*([A-Z0-9-]{4,20})/i)?.[1]|| null;

// Price extraction from email plaintext (deal price vs original price)const { dealPrice: textDealPrice, originalPrice: textOriginalPrice } = extractPricesFromText(plainText);

const primaryUrl = productUrls[0] || null;let primaryMeta  = null;if (primaryUrl) primaryMeta = await fetchAmazonMeta(primaryUrl);

const discount = claudeData?.discount || plainText.match(/(\d+)\s*%\s*(?|discount)/i)?.[1] || null;

const store       = getStore("submissions");const urlsToProcess = productUrls.length > 0 ? productUrls.slice(0, 20) : [null];const savedIds    = [];const deals       = [];

for (const dealUrl of urlsToProcess) {let meta = dealUrl === primaryUrl ? primaryMeta : null;if (!meta && dealUrl) meta = await fetchAmazonMeta(dealUrl);

const asin        = dealUrl?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || meta?.asin || null;
const affiliateUrl = asin

? https://www.amazon.com/dp/${asin}?tag=${process.env.AMAZON_PARTNER_TAG || 'daholic-20'}: dealUrl? (dealUrl.includes('tag=')? dealUrl: dealUrl + (dealUrl.includes('?') ? '&' : '?') + tag=${process.env.AMAZON_PARTNER_TAG || 'daholic-20'}): '';

const imageUrl = meta?.image || (asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg' : null);

// Title: clean whatever we get (Amazon page scrape wins over email text)
const rawTitle = meta?.title
  || (dealUrl === primaryUrl ? claudeData?.title : null)
  || plainText.split(/[\n.!?]/).find(l => l.trim().length > 10 && !l.includes('http'))?.trim().substring(0, 150)
  || null;
const dealTitle = cleanTitle(rawTitle) || 'Amazon Deal';

// Price: Amazon page scrape wins; fall back to email text extraction
const dealPrice = meta?.price         || (dealUrl === primaryUrl ? claudeData?.price : null)         || textDealPrice;
const origPrice = meta?.originalPrice || (dealUrl === primaryUrl ? claudeData?.originalPrice : null) || textOriginalPrice;

const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const submission = {
  id,
  title:         dealTitle,
  price:         dealPrice  || null,
  originalPrice: origPrice  || null,
  discount:      discount   || null,
  url:           affiliateUrl,
  imageUrl,
  discountCode:  discountCode || null,
  source:        'email',
  status:        'pending',
  sponsored:     false,
  createdAt:     new Date().toISOString(),
  expiresOn:     new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
};

await store.setJSON(id, submission);
savedIds.push(id);
deals.push({ id, title: dealTitle, price: dealPrice || null, url: affiliateUrl, imageUrl });

let index = [];
try { index = await store.get('index', { type: 'json' }) || []; } catch (e) { index = []; }
index.unshift(id);
await store.setJSON('index', index);
await new Promise(r => setTimeout(r, 10));

}

const telegramMessage = deals.length === 0 ? null: deals.length === 1? 🔥 <b>New Deal Alert!</b>\n\n🛍️ <b>${deals[0].title || 'Amazon Deal'}</b>\n\n💰 <b>${deals[0].price || 'Check link'}</b>\n\n🔗 <a href="${deals[0].url}">👉 Grab this deal!</a>: 🔥 <b>${deals.length} New Deals Alert!</b>\n\n + deals.map((d, i) =>${i + 1}. 🛍️ <b>${d.title || 'Amazon Deal'}</b>\n   💰 <b>${d.price || 'Check link'}</b>\n   🔗 <a href="${d.url}">Grab deal</a>).join('\n\n');

const facebookMessage = deals.length === 0 ? null: deals.length === 1? 🔥 New Deal Alert!\n\n🛍️ ${deals[0].title || 'Amazon Deal'}\n\n💰 ${deals[0].price || 'Check link'}\n\n👉 ${deals[0].url}\n\n#deals #amazon #dealsaholic #shopping #sale: 🔥 ${deals.length} New Deals Alert!\n\n + deals.map((d, i) =>${i + 1}. 🛍️ ${d.title || 'Amazon Deal'}\n   💰 ${d.price || 'Check link'}\n   👉 ${d.url}).join('\n\n') + '\n\n#deals #amazon #dealsaholic #shopping #sale';

return new Response(JSON.stringify({success:         true,count:           deals.length,ids:             savedIds,deals,amazonUrlsFound: productUrls.length,promoUrlsFound:  promoUrls.length,discountCode,telegramMessage,facebookMessage,title:    deals[0]?.title    || null,price:    deals[0]?.price    || null,url:      deals[0]?.url      || null,imageUrl: deals[0]?.imageUrl || null,}), { status: 200, headers: { 'Content-Type': 'application/json' } });};

export const config = { path: '/api/submit-email-deal' };
