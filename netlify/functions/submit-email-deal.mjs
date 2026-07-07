import { getStore } from "@netlify/blobs";

const PARTNER_TAG = 'kethya08-20';
const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG_ENV = process.env.AMAZON_PARTNER_TAG || PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

// ─── Amazon Creator API ───────────────────────────────────────────────────────

async function getAccessToken() {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: "creatorsapi::default",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    console.error('getAccessToken failed:', e.message);
    return null;
  }
}

// Search Amazon by title — returns { asin, image, title, url } or null
async function searchAmazonByTitle(title) {
  try {
    const accessToken = await getAccessToken();
    if (!accessToken) return null;
    const res = await fetch(CATALOG_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "x-marketplace": MARKETPLACE,
      },
      body: JSON.stringify({
        keywords: title,
        itemCount: 1,
        partnerTag: PARTNER_TAG_ENV,
        partnerType: "Associates",
        marketplace: MARKETPLACE,
        resources: [
          "images.primary.large",
          "itemInfo.title",
          "offersV2.listings.price",
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || data.searchResult?.items || [];
    if (!items[0]) return null;
    const item = items[0];
    const asin = item.asin;
    const image = item.images?.primary?.large?.url ||
      `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`;
    console.log(`Title search "${title}" → ASIN ${asin}`);
    return {
      asin,
      image,
      title: item.itemInfo?.title?.displayValue || null,
      url: `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG_ENV}`,
    };
  } catch (e) {
    console.error('searchAmazonByTitle failed:', e.message);
    return null;
  }
}

// ─── Amazon page scraper ──────────────────────────────────────────────────────

async function followRedirectForAsin(amazonUrl) {
  try {
    const res = await fetch(amazonUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
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
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
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

// ─── Text helpers ─────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isGarbageText(s) {
  if (!s) return true;
  let decoded = s;
  try { decoded = decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) {}
  const encodedMatches = s.match(/%[0-9A-Fa-f]{2}/g) || [];
  if (encodedMatches.length > 2) return true;
  const plusMatches = s.match(/\+/g) || [];
  if (plusMatches.length > 3) return true;
  if (/googleusercontent|googleapis|gstatic|promocode/i.test(decoded)) return true;
  if (/dummy_textarea|position.*absolute|overflow.*hidden|opacity.*0|emailBody=|<!DOCTYPE|<html|ExternalClass|MsoNormal|font-size|margin:|padding:|border:/i.test(decoded)) return true;
  if (/here\s+is\s+a\s+list|for\s+your\s+reference|original\s+price\s*:/i.test(decoded)) return true;
  const letters = (decoded.match(/[a-zA-Z\s]/g) || []).length;
  if (decoded.length > 0 && letters / decoded.length < 0.6) return true;
  if (decoded.trim().length < 8) return true;
  return false;
}

// ─── Per-product block parser ─────────────────────────────────────────────────

/*
  Splits email into product blocks. Each block contains:
  - title (from "Products title:" or "Product title:")
  - url (real dp URL or promocode URL)
  - code
  - discount %
  - price (discounted)
  - originalPrice
*/
function parseEmailIntoProductBlocks(text) {
  const blocks = [];

  // Split on product title markers
  const titlePattern = /(?:products?\s*title\s*[:：])/gi;
  const parts = text.split(titlePattern);

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];

    // Extract title — first non-empty line
    const titleLine = block.split('\n').map(l => l.trim()).find(l => l.length > 3 && !isGarbageText(l));
    const title = titleLine?.substring(0, 150) || null;
    if (!title) continue;

    // Extract real amazon dp URL
    const dpMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>]*/i)
      || block.match(/https?:\/\/amzn\.to\/[A-Za-z0-9]+/i)
      || block.match(/https?:\/\/a\.co\/[A-Za-z0-9\/]+/i);
    const realUrl = dpMatch ? dpMatch[0] : null;

    // Extract promocode URL
    const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/promocode\/[A-Z0-9]+/i);
    const promocodeUrl = promoMatch ? promoMatch[0] : null;

    // Extract discount code — look for code/coupon/promo ONLY in this block
    const codeMatch = block.match(/(?:code|coupon|promo)\s*[:：]\s*([A-Z0-9]{4,20})/i);
    const code = codeMatch ? codeMatch[1] : null;

    // Extract discount %
    const discountMatch = block.match(/(\d+)\s*%\s*(?:off|discount|OFF)/i)
      || block.match(/^(\d+)%/m);
    const discount = discountMatch ? discountMatch[1] : null;

    // Extract prices — get ALL dollar amounts in block
    const priceMatches = [...block.matchAll(/\$?\s*([\d]+\.[\d]{2})/g)].map(m => parseFloat(m[1]));
    const prices = priceMatches.filter(p => p > 0).sort((a, b) => a - b);
    const discountPrice = prices.length > 0 ? `$${prices[0].toFixed(2)}` : null;
    const originalPrice = prices.length > 1 ? `$${prices[prices.length - 1].toFixed(2)}` : null;

    blocks.push({
      title,
      realUrl,
      promocodeUrl,
      code,
      discount,
      price: discountPrice,
      originalPrice,
    });
  }

  // Fallback: if no blocks found via title pattern, treat whole email as one block
  if (blocks.length === 0) {
    const dpMatch = text.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>]*/i);
    const promoMatch = text.match(/https?:\/\/(?:www\.)?amazon\.com\/promocode\/[A-Z0-9]+/i);
    const codeMatch = text.match(/(?:code|coupon|promo)\s*[:：]\s*([A-Z0-9]{4,20})/i);
    const discountMatch = text.match(/(\d+)\s*%\s*(?:off|discount|OFF)/i);
    const priceMatches = [...text.matchAll(/\$?\s*([\d]+\.[\d]{2})/g)].map(m => parseFloat(m[1]));
    const prices = priceMatches.filter(p => p > 0).sort((a, b) => a - b);

    blocks.push({
      title: null, // will be fetched from Amazon
      realUrl: dpMatch ? dpMatch[0] : null,
      promocodeUrl: promoMatch ? promoMatch[0] : null,
      code: codeMatch ? codeMatch[1] : null,
      discount: discountMatch ? discountMatch[1] : null,
      price: prices.length > 0 ? `$${prices[0].toFixed(2)}` : null,
      originalPrice: prices.length > 1 ? `$${prices[prices.length - 1].toFixed(2)}` : null,
    });
  }

  return blocks;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

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
  const plainText = stripHtml(content);

  // Parse email into product blocks
  const blocks = parseEmailIntoProductBlocks(plainText);
  console.log(`Parsed ${blocks.length} product block(s) from email`);

  const store = getStore("submissions");
  const queueStore = getStore("deal-queue");
  const savedIds = [];
  const deals = [];
  const queueItems = [];

  for (const block of blocks) {
    let affiliateUrl = '';
    let imageUrl = null;
    let dealTitle = block.title;
    let asin = null;
    let status = 'pending';

    // ── CASE 1: Has real amazon.com/dp/ URL ──────────────────────────────────
    if (block.realUrl) {
      console.log(`Block "${block.title}" → real URL: ${block.realUrl}`);
      const meta = await fetchAmazonMeta(block.realUrl);
      asin = block.realUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || meta?.asin || null;
      affiliateUrl = asin
        ? `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`
        : block.realUrl.includes('tag=') ? block.realUrl : `${block.realUrl}?tag=${PARTNER_TAG}`;
      imageUrl = meta?.image || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);
      dealTitle = meta?.title || block.title || 'Amazon Deal';
      // Trustworthy if we have real URL + image
      if (affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
    }

    // ── CASE 2: Has promocode URL — search by title ──────────────────────────
    else if (block.promocodeUrl && block.title) {
      console.log(`Block "${block.title}" → promocode URL, searching by title...`);
      const searchResult = await searchAmazonByTitle(block.title);
      if (searchResult) {
        asin = searchResult.asin;
        affiliateUrl = searchResult.url;
        imageUrl = searchResult.image;
        dealTitle = block.title; // Keep email title — it's what the seller confirmed
        // Trustworthy if title search succeeded
        if (affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
        console.log(
