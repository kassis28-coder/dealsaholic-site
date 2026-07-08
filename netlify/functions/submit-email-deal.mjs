import { getStore } from "@netlify/blobs";

const PARTNER_TAG = 'kethya08-20';
const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG_ENV = process.env.AMAZON_PARTNER_TAG || PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

// ─── Amazon Creator API ────────────────────────────────────────────────────────────

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

// Visit promocode page and grab FIRST product ASIN only
async function resolvePromocodeToFirstAsin(promocodeUrl) {
  try {
    const res = await fetch(promocodeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/\/dp\/([A-Z0-9]{10})/i);
    if (!match) return null;
    const asin = match[1];
    console.log(`Resolved promocode ${promocodeUrl} → ASIN ${asin}`);
    return `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`;
  } catch (e) {
    console.error('resolvePromocodeToFirstAsin failed:', e.message);
    return null;
  }
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

// Emails often arrive URL-encoded (e.g. "79%0D%0AUse+sale+price"). Decode when
// the text clearly contains encoded sequences.
function maybeUrlDecode(text) {
  if (!text) return '';
  const enc = text.match(/%[0-9A-Fa-f]{2}/g) || [];
  if (enc.length < 3) return text;
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch (e) {
    return text;
  }
}

// Flattens everything to one line (for fallback searches)
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// IMPORTANT: preserves line breaks so the block parser can find
// "Products title:" markers and read titles line by line.
function stripHtmlKeepLines(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
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

// Extract deal fields from a block of text.
// prevTail = last chars of the previous block (some senders put "Discount:50%OFF"
// on the line right BEFORE the "Title:" line).
function extractFieldsFromBlock(block, prevTail) {
  // URLs
  const dpMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>]*/i)
    || block.match(/https?:\/\/amzn\.to\/[A-Za-z0-9]+/i)
    || block.match(/https?:\/\/a\.co\/[A-Za-z0-9\/]+/i);
  const realUrl = dpMatch ? dpMatch[0] : null;
  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/\s*promocode\/\s*[A-Z0-9]+/i);
  const promocodeUrl = promoMatch ? promoMatch[0].replace(/\s+/g, '') : null;

  // Discount code — "Code: X", "code:X", "50% Code: X", "Coupon: X"
  // (never matches "CC ID:", "Campaign ID:" or the word "promocode" in URLs)
  const codeMatch = block.match(/(?:discount\s*code|promo\s*code|coupon\s*code|code|coupon)\s*[:：]\s*"?([A-Z0-9]{4,20})\b/i);
  const code = codeMatch ? codeMatch[1] : null;

  // Deal price — labeled forms first, then a line starting with "Price:"
  const dealPriceMatch =
    block.match(/(?:deal\s*price|product\s*price|sale\s*price|after\s*(?:the\s*)?discount\s*price|price\s*after\s*discount|final\s*price)\s*[:：]?\s*\$?\s*([\d]+(?:\.[\d]+)?)/i)
    || block.match(/(?:^|\n)[ \t]*price\s*[:：]\s*\$?\s*([\d]+(?:\.[\d]+)?)/i);

  // Original price — "Original price:", "Price before discount:", "(Reg. $x)", "List price"
  const origPriceMatch =
    block.match(/(?:original\s*price|price\s*before\s*discount|list\s*price|was)\s*[:：]?\s*\$?\s*([\d]+(?:\.[\d]+)?)/i)
    || block.match(/\breg(?:ular)?\.?\s*(?:price)?\s*[:：]?\s*\$?\s*([\d]+(?:\.[\d]+)?)/i);

  let dealPriceNum = dealPriceMatch ? parseFloat(dealPriceMatch[1]) : null;
  let origPriceNum = origPriceMatch ? parseFloat(origPriceMatch[1]) : null;

  // Fallback: scan all dollar amounts — lowest = deal, highest = original
  if (dealPriceNum == null || origPriceNum == null) {
    const amounts = [...block.matchAll(/\$\s*([\d]+\.[\d]{1,2})\b/g)].map(m => parseFloat(m[1])).filter(p => p > 0);
    if (amounts.length > 0) {
      const sorted = [...amounts].sort((a, b) => a - b);
      if (dealPriceNum == null) dealPriceNum = sorted[0];
      if (origPriceNum == null && sorted.length > 1) origPriceNum = sorted[sorted.length - 1];
    }
  }
  if (dealPriceNum != null && origPriceNum != null && origPriceNum < dealPriceNum) {
    const t = dealPriceNum; dealPriceNum = origPriceNum; origPriceNum = t;
  }

  // Discount % — some senders put "Discount:50%OFF" on the line right BEFORE
  // the title, so a trailing labeled discount in prevTail wins; then in-block.
  let discount = prevTail
    ? (prevTail.match(/discount\s*[:：]?\s*(\d{1,2})\s*%\s*(?:off)?\s*$/i) || [])[1] || null
    : null;
  if (!discount) {
    discount = (block.match(/discount\s*[:：]?\s*(\d{1,2})\s*%/i)
      || block.match(/(\d{1,2})\s*%\s*(?:off|discount|code)/i)
      || [])[1] || null;
  }
  if (!discount && dealPriceNum != null && origPriceNum != null && origPriceNum > 0) {
    const pct = Math.round((1 - dealPriceNum / origPriceNum) * 100);
    if (pct >= 5 && pct <= 95) discount = String(pct);
  }

  // Expiry — "End Date: 2026-7-20", "End Day: 07/18/2026", "End: 2026-07-28"
  const endMatch = block.match(/end\s*(?:date|day|time)?\s*[:：]?\s*([\d]{4}-[\d]{1,2}-[\d]{1,2}|[\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i);
  let endDate = null;
  if (endMatch) {
    try {
      let d;
      if (endMatch[1].includes('/')) {
        const p = endMatch[1].split('/');
        d = new Date(`${p[2]}-${p[0].padStart(2, '0')}-${p[1].padStart(2, '0')}T23:59:59Z`);
      } else {
        const p = endMatch[1].split('-');
        d = new Date(`${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}T23:59:59Z`);
      }
      if (!isNaN(d.getTime()) && d.getTime() > Date.now()) endDate = d.toISOString();
    } catch (e) {}
  }

  return {
    realUrl,
    promocodeUrl,
    code,
    discount,
    price: dealPriceNum != null ? `$${dealPriceNum.toFixed(2)}` : null,
    originalPrice: origPriceNum != null ? `$${origPriceNum.toFixed(2)}` : null,
    endDate,
  };
}

/*
Splits email into product blocks. Title markers seen in real deal emails:
  "Title: 8-Pack Solar Fence Lights"
  "Product name: BEYOUDO Seat Belt Pillow..."
  "Product Name: MEROKEETY Women's..."
  "Products title: ..." / "Product title: ..."
  numbered variants: `1、"Product Name: ..."`, "1.ME925sweater22" + "Product Name:"
NOTE: must be fed line-preserving text (stripHtmlKeepLines), NOT stripHtml.
*/
function parseEmailIntoProductBlocks(text) {
  const blocks = [];

  // Split on product title markers at line starts
  const titlePattern = /(?:^|\n)[ \t]*(?:\d+\s*[.、][ \t]*)?["'“]?(?:products?\s*(?:name|title)|title)\s*[:：]/gi;
  const parts = text.split(titlePattern);

  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const prevTail = parts[i - 1].slice(-160);

    // Title = rest of the marker line; fall back to first usable line
    const lines = block.split('\n').map(l => l.trim());
    let title = lines.find(l => l.length > 3 && !/^https?:\/\//i.test(l) && !isGarbageText(l)) || null;
    if (title) {
      title = title.replace(/^["'“]+|["'”,，]+$/g, '').trim().substring(0, 150) || null;
    }

    const fields = extractFieldsFromBlock(block, prevTail);
    if (!title && !fields.realUrl && !fields.promocodeUrl) continue;

    blocks.push({ title, ...fields });
  }

  // Fallback: if no blocks found via title pattern, treat whole email as one block
  if (blocks.length === 0) {
    const fields = extractFieldsFromBlock(text, '');
    blocks.push({ title: null, ...fields }); // title will be fetched from Amazon
  }

  return blocks.slice(0, 20);
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

  let content = (emailBody || title).trim();

  // Unwrap JSON payloads like { "emailBody": "..." }
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.emailBody) content = String(parsed.emailBody);
      else if (parsed.snippet) content = String(parsed.snippet);
    }
  } catch (e) {}

  // Decode URL-encoded bodies (fixes "79%0D%0AUse+sale+price" garbage)
  content = maybeUrlDecode(content);

  const lineText = stripHtmlKeepLines(content);
  const plainText = stripHtml(content);

  // Parse email into product blocks (line-preserving text!)
  const blocks = parseEmailIntoProductBlocks(lineText);
  console.log(`Parsed ${blocks.length} product block(s) from email`);

  const store = getStore("submissions");
  const queueStore = getStore("deal-queue");
  const savedIds = [];
  const deals = [];
  const queueItems = [];
  const seenAsins = new Set();

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
        : block.realUrl.includes('tag=') ? block.realUrl : `${block.realUrl}${block.realUrl.includes('?') ? '&' : '?'}tag=${PARTNER_TAG}`;
      imageUrl = meta?.image || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);
      dealTitle = (meta?.title && !isGarbageText(meta.title) ? meta.title : null) || block.title || 'Amazon Deal';
      if (affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
    }

    // ── CASE 2: Has promocode URL — search by title, fall back to promo page ──
    else if (block.promocodeUrl) {
      let resolved = null;
      if (block.title) {
        console.log(`Block "${block.title}" → promocode URL, searching by title...`);
        const searchResult = await searchAmazonByTitle(block.title);
        if (searchResult) {
          asin = searchResult.asin;
          affiliateUrl = searchResult.url;
          imageUrl = searchResult.image;
          dealTitle = block.title; // Keep email title — it's what the seller confirmed
          if (affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
          console.log(`Title search matched ASIN ${asin} for "${block.title}"`);
          resolved = true;
        }
      }
      if (!resolved) {
        // Title search failed — resolve promocode page to its first product
        const promoResolvedUrl = await resolvePromocodeToFirstAsin(block.promocodeUrl);
        if (promoResolvedUrl) {
          asin = promoResolvedUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
          const meta = await fetchAmazonMeta(promoResolvedUrl);
          affiliateUrl = promoResolvedUrl;
          imageUrl = meta?.image || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);
          dealTitle = block.title || (meta?.title && !isGarbageText(meta.title) ? meta.title : null) || 'Amazon Deal';
          // Resolved from promo page — leave pending unless title came from email
          if (block.title && affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
        } else {
          console.log(`Could not resolve promocode URL: ${block.promocodeUrl}`);
        }
      }
    }

    // ── CASE 3: Title only — search Amazon by title ───────────────────────────
    else if (block.title) {
      console.log(`Block "${block.title}" → no URL, searching by title...`);
      const searchResult = await searchAmazonByTitle(block.title);
      if (searchResult) {
        asin = searchResult.asin;
        affiliateUrl = searchResult.url;
        imageUrl = searchResult.image;
        dealTitle = block.title;
        if (affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
      }
    }

    // Skip blocks that produced nothing usable at all
    if (!affiliateUrl && !dealTitle) continue;
    // Skip duplicate products (same ASIN found twice in one email)
    if (asin && seenAsins.has(asin)) continue;
    if (asin) seenAsins.add(asin);

    if (!dealTitle || isGarbageText(dealTitle)) dealTitle = 'Amazon Deal';
    if (dealTitle === 'Amazon Deal') status = 'pending';

    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id,
      title: dealTitle,
      price: block.price || null,
      originalPrice: block.originalPrice || null,
      discount: block.discount || null,
      url: affiliateUrl,
      imageUrl,
      discountCode: block.code || null,
      source: "email",
      status,
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: block.endDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await store.setJSON(id, submission);
    savedIds.push(id);
    deals.push({ id, title: dealTitle, price: block.price || null, url: affiliateUrl, imageUrl });

    if (status === 'approved') {
      queueItems.push({
        id,
        title: dealTitle,
        price: block.price || null,
        originalPrice: block.originalPrice || null,
        discount: block.discount || null,
        url: affiliateUrl,
        imageUrl,
        promoCode: block.code || null,
        asin,
        store: 'amazon',
      });
    }

    let index = [];
    try { index = await store.get("index", { type: "json" }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);
    await new Promise(r => setTimeout(r, 10));
  }

  // Add approved deals to the Telegram/Facebook posting queue
  if (queueItems.length > 0) {
    try {
      let queue = [];
      try { queue = await queueStore.get('queue', { type: 'json' }) || []; } catch (e) { queue = []; }
      queue.push(...queueItems);
      await queueStore.setJSON('queue', queue);
    } catch (e) { console.error('Queue write failed:', e.message); }
  }

  const telegramMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 <b>New Deal Alert!</b>\n\n🛍️ <b>${deals[0].title || 'Amazon Deal'}</b>\n\n💰 <b>${deals[0].price || 'Check link'}</b>\n\n🔗 <a href="${deals[0].url}">👉 Grab this deal!</a>`
      : `🔥 <b>${deals.length} New Deals Alert!</b>\n\n` + deals.map((d, i) =>
          `${i + 1}. 🛍️ <b>${d.title || 'Amazon Deal'}</b>\n 💰 <b>${d.price || 'Check link'}</b>\n 🔗 <a href="${d.url}">Grab deal</a>`
        ).join('\n\n');

  const facebookMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 New Deal Alert!\n\n🛍️ ${deals[0].title || 'Amazon Deal'}\n\n💰 ${deals[0].price || 'Check link'}\n\n👉 ${deals[0].url}\n\n#ad #deals #amazon #dealsaholic #shopping #sale`
      : `🔥 ${deals.length} New Deals Alert!\n\n` + deals.map((d, i) =>
          `${i + 1}. 🛍️ ${d.title || 'Amazon Deal'}\n 💰 ${d.price || 'Check link'}\n 👉 ${d.url}`
        ).join('\n\n') + '\n\n#ad #deals #amazon #dealsaholic #shopping #sale';

  return new Response(JSON.stringify({
    success: true, count: deals.length, ids: savedIds, deals,
    productBlocksFound: blocks.length,
    telegramMessage, facebookMessage,
    title: deals[0]?.title || null, price: deals[0]?.price || null,
    url: deals[0]?.url || null, imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/submit-email-deal" };
