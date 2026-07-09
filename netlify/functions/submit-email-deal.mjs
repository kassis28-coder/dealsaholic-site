import { getStore } from "@netlify/blobs";

const PARTNER_TAG = 'kethya08-20';
const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG_ENV = process.env.AMAZON_PARTNER_TAG || PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

// âââ Amazon Creator API âââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

// Search Amazon by title â returns { asin, image, title, url } or null
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
    console.log(`Title search "${title}" â ASIN ${asin}`);
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

// âââ Amazon page scraper ââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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
      return {
        title: null, price: null,
        image: `https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg`,
        asin: asinFromRedirect, finalUrl: redirectUrl,
      };
    }
    const finalUrl = res.url;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || asinFromRedirect || null;
    const html = await res.text();
    const title =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const image =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);
    const priceMatch =
      html.match(/["']priceAmount["']\s*:\s*["']?([\d.]+)["']?/)
      || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;
    return {
      title: title?.replace(/\s*[|:]\s*amazon\b.*/i, '')
                   .replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '')
                   .trim().substring(0, 150) || null,
      image, price, asin, finalUrl,
    };
  } catch (e) {
    if (!asinFromRedirect) return null;
    return {
      title: null, price: null,
      image: `https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg`,
      asin: asinFromRedirect, finalUrl: redirectUrl,
    };
  }
}

// âââ Text helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

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

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Preserves line breaks so the block parser can find markers line by line.
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
    .replace(/\n{3,}/g, '\n\n')
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

// âââ Date parsing âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Parses date strings from supplier emails into ISO 8601.
// Handles: "2026-7-7", "2026-7-0706:00PDT" (concatenated), "2026-07-07T00:00",
//          "2026-7-08 01:00 PDT", "2026-7-15 23:59PDT"
function parseDateString(raw, defaultHour = '00', defaultMin = '00') {
  if (!raw) return null;
  // Strip timezone labels, collapse whitespace
  let s = raw
    .replace(/\s*(?:PDT|PST|PST8PDT|EDT|EST|UTC|GMT)[^\s]*/gi, '')
    .replace('T', ' ')
    .trim();

  // Pattern: YYYY-M-DD[HH:MM] â day is 2 digits when time is concatenated
  // e.g. "2026-7-0706:00" â yr=2026, mo=7, dy=07, hr=06, mn=00
  const concat = s.match(/^(\d{4})-(\d{1,2})-(\d{2})(\d{2}:\d{2})?$/);
  if (concat) {
    const [, yr, mo, dy, tm] = concat;
    const [hr, mn] = tm ? tm.split(':') : [defaultHour, defaultMin];
    const d = new Date(`${yr}-${mo.padStart(2,'0')}-${dy}T${hr.padStart(2,'0')}:${mn.padStart(2,'0')}:00Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Pattern: YYYY-M-D[ HH:MM] â space-separated or date-only
  const standard = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (standard) {
    const [, yr, mo, dy, hr = defaultHour, mn = defaultMin] = standard;
    const d = new Date(
      `${yr}-${mo.padStart(2,'0')}-${dy.padStart(2,'0')}` +
      `T${String(hr).padStart(2,'0')}:${String(mn).padStart(2,'0')}:00Z`
    );
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

// âââ Price helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Parses a price string that may be a single number or a range ("16.64-17.99").
// Returns { low, high, isRange, raw } or null.
function parsePriceValue(str) {
  if (!str) return null;
  const s = str.trim().replace(/^\$/, '');
  const rangeMatch = s.match(/^([\d]+(?:\.[\d]+)?)\s*[-â]\s*([\d]+(?:\.[\d]+)?)$/);
  if (rangeMatch) {
    return {
      low: parseFloat(rangeMatch[1]),
      high: parseFloat(rangeMatch[2]),
      raw: s,
      isRange: true,
    };
  }
  const single = parseFloat(s);
  if (isNaN(single)) return null;
  return { low: single, high: single, raw: s, isRange: false };
}

function formatPrice(p) {
  if (!p) return null;
  return p.isRange ? `$${p.raw}` : `$${p.low.toFixed(2)}`;
}

// âââ Per-product block field extractor âââââââââââââââââââââââââââââââââââââââ

// Extracts all deal fields from a single isolated block of text.
// prevTail = last ~200 chars of the preceding text segment (catches discount %
// placed on the line immediately before the "Title:" marker).
function extractFieldsFromBlock(block, prevTail) {
  // ââ Amazon URLs âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // /dp/ASIN or /gp/product/ASIN â strip trailing quote/punctuation
  const dpMatch =
    block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>\n]*/i)
    || block.match(/https?:\/\/amzn\.to\/[A-Za-z0-9]+/i)
    || block.match(/https?:\/\/a\.co\/[A-Za-z0-9/]+/i);
  const realUrl = dpMatch ? dpMatch[0].replace(/["'\s]+$/, '') : null;

  // ASIN extracted directly from the URL â never guessed
  const asinFromUrl = realUrl
    ? (realUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null)
    : null;

  // /promocode/ URL â signals no ASIN available; image must NOT be guessed
  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/promocode\/[A-Z0-9]+/i);
  const promocodeUrl = promoMatch ? promoMatch[0].replace(/\s+/g, '') : null;

  // ââ Promo code ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Accepts: Code:, code:, Coupon Code:, Promo Code:, Discount Code:
  // Requires 4-20 uppercase alphanumeric chars (prevents matching "5%" from "Coupon:5%")
  const codeMatch = block.match(
    /(?:discount\s*code|promo(?:tion)?\s*code|coupon\s*code|(?<![a-zA-Z])code|(?<![a-zA-Z])coupon)\s*[:ï¼]\s*["']?([A-Z0-9]{4,20})\b/i
  );
  const promoCode = codeMatch ? codeMatch[1].toUpperCase() : null;

  // ââ Coupon percentage â separate field (e.g. "Coupon:5%") ââââââââââââââââââ
  const couponPctMatch = block.match(/(?<![a-zA-Z])coupon\s*[:ï¼]\s*(\d{1,3})\s*%/i);
  // Only set if the match is distinct from the promoCode match
  const couponPct = couponPctMatch
    ? (promoCode && couponPctMatch[0].includes(promoCode) ? null : couponPctMatch[1])
    : null;

  // ââ Sale price ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Labels (all normalized to salePrice):
  //   Deal Price Â· Discount price Â· Product Price Â· Sale price
  //   After the discount price Â· Price after discount Â· Final price
  const PRICE_PATTERN = /\$?\s*([\d]+(?:\.[\d]+)?(?:\s*[-â]\s*[\d]+(?:\.[\d]+)?)?)/;
  const saleLabelRe = new RegExp(
    '(?:deal\\s*price|discount\\s*price|product\\s*price|sale\\s*price' +
    '|after\\s*(?:the\\s*)?discount\\s*price|price\\s*after\\s*discount|final\\s*price)' +
    '\\s*[:ï¼]?\\s*' + PRICE_PATTERN.source,
    'i'
  );
  // Also catch a bare "Price:" line (but not "Original price:" etc.)
  const barePriceRe = new RegExp(
    '(?:^|\\n)[ \\t]*price\\s*[:ï¼]\\s*' + PRICE_PATTERN.source,
    'i'
  );
  const salePriceRaw = (block.match(saleLabelRe) || block.match(barePriceRe))?.[1] || null;
  let salePrice = parsePriceValue(salePriceRaw);

  // ââ Original price ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Labels: Original price Â· Price before discount Â· List price Â· Was Â· Reg/Regular price
  const origLabelRe = new RegExp(
    '(?:original\\s*price|price\\s*before\\s*discount|list\\s*price|was' +
    '|reg(?:ular)?\\.?\\s*(?:price)?)' +
    '\\s*[:ï¼]?\\s*' + PRICE_PATTERN.source,
    'i'
  );
  const origPriceRaw = block.match(origLabelRe)?.[1] || null;
  let origPrice = parsePriceValue(origPriceRaw);

  // Swap if order is inverted (only for single-value prices)
  if (salePrice && origPrice && !salePrice.isRange && !origPrice.isRange
      && origPrice.low < salePrice.low) {
    [salePrice, origPrice] = [origPrice, salePrice];
  }

  // Fallback: scan bare dollar amounts when both prices still unknown
  if (!salePrice && !origPrice) {
    const amounts = [...block.matchAll(/\$\s*([\d]+\.[\d]{1,2})\b/g)]
      .map(m => parseFloat(m[1])).filter(p => p > 0);
    if (amounts.length >= 2) {
      const sorted = [...amounts].sort((a, b) => a - b);
      salePrice = parsePriceValue(String(sorted[0]));
      origPrice = parsePriceValue(String(sorted[sorted.length - 1]));
    }
  }

  // ââ Discount % âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Formats: Discount:50%OFF Â· %offï¼40% Â· 40% off Â· 52% off Prime Â· 50%
  let discount = null;

  // Check prevTail â catches "Discount:50%OFF" placed before a "Title:" line
  if (prevTail) {
    const ptm = prevTail.match(/(?:discount|%off)\s*[:ï¼]?\s*(\d{1,2})\s*%/i);
    if (ptm) discount = ptm[1];
  }

  if (!discount) {
    const dm =
      block.match(/(?:^|[\n\s])(?:discount|%off)\s*[:ï¼]\s*(\d{1,2})\s*%/i)      // Discount:50% / %offï¼40%
      || block.match(/(\d{1,2})\s*%\s*(?:off(?:\s+prime)?|OFF(?:\s+PRIME)?)\b/i) // 40% off / 52% off Prime
      || block.match(/(\d{1,2})\s*%\s*(?:discount)\b/i);
    if (dm) discount = dm[1];
  }

  // Compute from prices when still unknown
  if (!discount && salePrice && origPrice
      && !salePrice.isRange && !origPrice.isRange && origPrice.low > 0) {
    const pct = Math.round((1 - salePrice.low / origPrice.low) * 100);
    if (pct >= 5 && pct <= 95) discount = String(pct);
  }

  // ââ Start date âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  // Handles: "2026-7-7", "2026-7-0706:00PDT", "2026-07-07T00:00", "2026-7-08 01:00 PDT"
  const startRaw = block.match(
    /start\s*(?:date|day|time)?\s*[:ï¼]?\s*([\d]{4}-[\d]{1,2}-[\d]{1,2}(?:\s*T?\s*[\d]{1,2}:[\d]{2})?)/i
  );
  const startDate = startRaw ? parseDateString(startRaw[1], '00', '00') : null;

  // ââ End date âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const endRaw = block.match(
    /end\s*(?:date|day|time)?\s*[:ï¼]?\s*([\d]{4}-[\d]{1,2}-[\d]{1,2}(?:\s*T?\s*[\d]{1,2}:[\d]{2})?)/i
  );
  const endDateParsed = endRaw ? parseDateString(endRaw[1], '23', '59') : null;
  // Discard past dates
  const endDate = (endDateParsed && new Date(endDateParsed).getTime() > Date.now())
    ? endDateParsed : null;

  return {
    asinFromUrl,
    realUrl,
    promocodeUrl,
    promoCode,
    couponPct,
    discount,
    salePrice:     formatPrice(salePrice),
    originalPrice: formatPrice(origPrice),
    startDate,
    endDate,
  };
}

// âââ Title extraction âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Lines that are field labels, campaign metadata, or URLs â not product titles
const FIELD_LINE_RE = /^(?:original\s*price|price\s*before|deal\s*price|discount\s*price|product\s*price|sale\s*price|after\s*the\s*discount|final\s*price|code\s*[:ï¼]|coupon\s*[:ï¼]|promo|link\s*[:ï¼]|start\s*(?:date|day|time)|end\s*(?:date|day|time)|%off|discount\s*[:ï¼]|\d+\s*%|https?:\/\/|us\d+\s+creator|creator\s+campaign|campaign\s*id|dear\s+friend|today\s+we)/i;

function extractTitleFromBlock(blockText, strategy) {
  const lines = blockText.split('\n').map(l => l.trim()).filter(Boolean);

  if (strategy === 'label') {
    // Block starts immediately after the title label colon â first line IS the title value,
    // possibly followed by inline field labels on the same line.
    const firstLine = lines[0] || '';
    const inlineFieldMatch = firstLine.match(
      /\b(?:original\s*price|price\s*before|deal\s*price|discount\s*price|product\s*price|sale\s*price|after\s*(?:the\s*)?discount|code\s*[:ï¼]|coupon\s*[:ï¼]|link\s*[:ï¼]|start\s*date|end\s*(?:date|day)|%off\s*[:ï¼]|\d+\s*%\s*off)/i
    );
    const raw = inlineFieldMatch
      ? firstLine.slice(0, inlineFieldMatch.index)
      : firstLine;
    const title = raw.replace(/^["""'\s]+|["""'",ï¼\s]+$/g, '').substring(0, 200);
    if (title.length > 4 && !isGarbageText(title)) return title;
    // Fall through to scan remaining lines for a title label
  }

  if (strategy === 'numbered') {
    // First line has the number prefix (e.g. "1.ME923sweater15").
    // Look for an explicit Product Name: label on lines 2-4 first.
    for (const line of lines.slice(1, 4)) {
      const m = line.match(/^["""']?(?:products?\s*(?:name|title)|title)\s*[:ï¼]\s*(.+)/i);
      if (m) {
        const title = m[1].replace(/^["""'\s]+|["""'",ï¼\s]+$/g, '').substring(0, 200);
        if (!isGarbageText(title)) return title;
      }
    }
    // No label â use first non-number, non-field, non-URL line
    for (const line of lines.slice(1)) {
      if (!FIELD_LINE_RE.test(line) && !/^https?:\/\//i.test(line)
          && line.length > 10 && !isGarbageText(line)) {
        return line.replace(/^["""'\s]+|["""'",ï¼\s]+$/g, '').substring(0, 200);
      }
    }
  }

  // Fallback: scan all lines for an explicit title label
  for (const line of lines) {
    const m = line.match(/^["""']?(?:products?\s*(?:name|title)|title)\s*[:ï¼]\s*(.+)/i);
    if (m) {
      const title = m[1].replace(/^["""'\s]+|["""'",ï¼\s]+$/g, '').substring(0, 200);
      if (!isGarbageText(title)) return title;
    }
  }

  // Last resort: first meaningful line that is not a field label or URL
  for (const line of lines) {
    if (!FIELD_LINE_RE.test(line) && !/^https?:\/\//i.test(line)
        && line.length > 10 && !isGarbageText(line)) {
      return line.replace(/^["""'\s]+|["""'",ï¼\s]+$/g, '').substring(0, 200);
    }
  }

  return null;
}

// âââ Block splitting ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

// Split text at explicit character positions; returns [{blockText, prevTail}].
function splitAtPositions(text, positions) {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  return sorted.map((start, i) => ({
    blockText: text.slice(start, sorted[i + 1] ?? text.length).trim(),
    prevTail:  text.slice(0, start).slice(-200),
  }));
}

// Split the email into isolated per-product blocks using four strategies in order.
// Returns an array of parsed block objects ready for Amazon enrichment.
function parseEmailIntoProductBlocks(text) {
  const results = [];

  function addBlock(blockText, prevTail, strategy) {
    if (blockText.length < 5) return;
    const title = extractTitleFromBlock(blockText, strategy);
    const fields = extractFieldsFromBlock(blockText, prevTail);
    if (!title && !fields.realUrl && !fields.promocodeUrl) return;
    results.push({ title, ...fields });
  }

  // ââ Strategy 1: Split on title label markers ââââââââââââââââââââââââââââââââ
  // Handles: Title:  Product name:  Product Name:  Product title:  Products title:
  // Works inline (e.g. "Discount:50%OFF Title:Product") AND at line starts.
  const TITLE_LABEL_RE = /(?:products?\s*(?:name|title)|(?<![a-zA-Z])title)\s*[:ï¼]/gi;
  const titleMatches = [...text.matchAll(TITLE_LABEL_RE)];

  if (titleMatches.length > 0) {
    // Split positions point to immediately AFTER the label colon,
    // so each blockText begins with the title value.
    const segs = splitAtPositions(text, titleMatches.map(m => m.index + m[0].length));
    for (const { blockText, prevTail } of segs) {
      addBlock(blockText, prevTail, 'label');
    }
    if (results.length > 0) return results.slice(0, 20);
  }

  // ââ Strategy 2: Split on numbered list prefixes at line start âââââââââââââââ
  // Handles: "1ã ...", "1. ...", "2." â even without a following title label
  const NUMBERED_RE = /(?:^|\n)[ \t]*\d+\s*[.ã]/gm;
  const numMatches = [...text.matchAll(NUMBERED_RE)];

  if (numMatches.length > 0) {
    const positions = numMatches.map(m => m.index + (text[m.index] === '\n' ? 1 : 0));
    const segs = splitAtPositions(text, positions);
    for (const { blockText, prevTail } of segs) {
      addBlock(blockText, prevTail, 'numbered');
    }
    if (results.length > 0) return results.slice(0, 20);
  }

  // ââ Strategy 3: Split on double blank lines âââââââââââââââââââââââââââââââââ
  const blankParts = text.split(/\n{2,}/);
  if (blankParts.length > 1) {
    let offset = 0;
    for (const part of blankParts) {
      const trimmed = part.trim();
      const prevTail = text.slice(0, offset).slice(-200);
      if (trimmed.length >= 10) addBlock(trimmed, prevTail, 'fallback');
      offset += part.length + 2; // approximate
    }
    if (results.length > 0) return results.slice(0, 20);
  }

  // ââ Strategy 4: Whole email as a single block âââââââââââââââââââââââââââââââ
  addBlock(text, '', 'fallback');
  return results;
}

// âââ Main handler âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export default async (req, context) => {
  const urlObj = new URL(req.url);
  const debugMode = urlObj.searchParams.get('debug') === 'true';

  let emailBody = '', title = '', snippet = '';

  if (req.method === 'GET') {
    emailBody = urlObj.searchParams.get('emailBody') || '';
    title     = urlObj.searchParams.get('title')     || '';
    snippet   = urlObj.searchParams.get('snippet')   || '';
  } else if (req.method === 'POST') {
    try { emailBody = await req.text(); } catch (e) { emailBody = ''; }
  }

  let content = (emailBody || title).trim();

  // Unwrap JSON payloads like { "emailBody": "..." }
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.emailBody)  content = String(parsed.emailBody);
      else if (parsed.snippet) content = String(parsed.snippet);
    }
  } catch (e) {}

  content = maybeUrlDecode(content);
  const lineText = stripHtmlKeepLines(content);

  // Parse email into per-product blocks (must use line-preserving text)
  const blocks = parseEmailIntoProductBlocks(lineText);
  console.log(`Parsed ${blocks.length} product block(s) from email (debug=${debugMode})`);

  // ââ Debug mode: return JSON preview, no Blobs, no queue ââââââââââââââââââââââ
  if (debugMode) {
    const preview = blocks.map(block => ({
      title:         block.title || null,
      asin:          block.asinFromUrl || null,
      originalPrice: block.originalPrice || null,
      salePrice:     block.salePrice || null,
      discount:      block.discount ? `${block.discount}%` : null,
      promoCode:     block.promoCode || null,
      couponPct:     block.couponPct ? `${block.couponPct}%` : null,
      amazonUrl:     block.realUrl || block.promocodeUrl || null,
      imageUrl:      null, // resolved at post time; not available in debug
      startDate:     block.startDate || null,
      endDate:       block.endDate || null,
      flags: {
        asinMissing:   !block.asinFromUrl && !!block.promocodeUrl,
        hasPromocode:  !!block.promocodeUrl,
      },
    }));
    return new Response(JSON.stringify({ debug: true, count: blocks.length, deals: preview }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ââ Normal mode: enrich, save to Blobs, queue approved deals âââââââââââââââââ
  const store      = getStore("submissions");
  const queueStore = getStore("deal-queue");
  const savedIds   = [];
  const deals      = [];
  const queueItems = [];
  const seenAsins  = new Set();

  for (const block of blocks) {
    let affiliateUrl = '';
    let imageUrl     = null;
    let dealTitle    = block.title;
    let asin         = null;
    let status       = 'pending';
    let asinMissing  = false;

    // ââ CASE 1: Real /dp/ or /gp/product/ URL â ASIN is known ââââââââââââââââ
    if (block.realUrl) {
      console.log(`Block "${block.title}" â real URL: ${block.realUrl}`);
      const meta = await fetchAmazonMeta(block.realUrl);
      asin = block.asinFromUrl || meta?.asin || null;
      affiliateUrl = asin
        ? `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`
        : (block.realUrl.includes('tag=')
            ? block.realUrl
            : `${block.realUrl}${block.realUrl.includes('?') ? '&' : '?'}tag=${PARTNER_TAG}`);
      // Image comes from Amazon scrape only â never from email text
      imageUrl  = meta?.image || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);
      dealTitle = (meta?.title && !isGarbageText(meta.title) ? meta.title : null)
                  || block.title
                  || 'Amazon Deal';
      if (affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
    }

    // ââ CASE 2: /promocode/ URL â ASIN unknown; do NOT guess image ââââââââââââ
    else if (block.promocodeUrl) {
      console.log(`Block "${block.title}" â promocode URL (no ASIN): ${block.promocodeUrl}`);
      asinMissing  = true;
      affiliateUrl = block.promocodeUrl;
      imageUrl     = null; // intentionally null â no guessing
      dealTitle    = block.title || 'Amazon Deal';
      // Save as pending; admin reviews and adds image manually
      status = 'pending';
    }

    // ââ CASE 3: Title only â search Amazon by title âââââââââââââââââââââââââââ
    else if (block.title) {
      console.log(`Block "${block.title}" â no URL, searching by title...`);
      const searchResult = await searchAmazonByTitle(block.title);
      if (searchResult) {
        asin         = searchResult.asin;
        affiliateUrl = searchResult.url;
        imageUrl     = searchResult.image;
        dealTitle    = block.title;
        if (affiliateUrl && imageUrl && !isGarbageText(dealTitle)) status = 'approved';
      }
    }

    // Skip blocks that produced nothing usable
    if (!affiliateUrl && !dealTitle) continue;
    // Skip duplicate ASINs within the same email
    if (asin && seenAsins.has(asin)) continue;
    if (asin) seenAsins.add(asin);

    if (!dealTitle || isGarbageText(dealTitle)) dealTitle = 'Amazon Deal';
    if (dealTitle === 'Amazon Deal') status = 'pending';

    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    const submission = {
      id,
      title:        dealTitle,
      price:        block.salePrice     || null,
      originalPrice: block.originalPrice || null,
      discount:     block.discount      || null,
      url:          affiliateUrl,
      imageUrl,
      discountCode: block.promoCode     || null,
      couponPct:    block.couponPct     || null,
      source:       "email",
      status,
      asinMissing,
      sponsored:    false,
      createdAt:    new Date().toISOString(),
      startDate:    block.startDate     || null,
      expiresOn:    block.endDate       || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.setJSON(id, submission);
    savedIds.push(id);
    deals.push({ id, title: dealTitle, price: block.salePrice || null, url: affiliateUrl, imageUrl });

    if (status === 'approved') {
      queueItems.push({
        id,
        title:         dealTitle,
        price:         block.salePrice     || null,
        originalPrice: block.originalPrice || null,
        discount:      block.discount      || null,
        url:           affiliateUrl,
        imageUrl,
        promoCode:     block.promoCode     || null,
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
      ? `ð¥ <b>New Deal Alert!</b>\n\nðï¸ <b>${deals[0].title || 'Amazon Deal'}</b>\n\nð° <b>${deals[0].price || 'Check link'}</b>\n\nð <a href="${deals[0].url}">ð Grab this deal!</a>`
      : `ð¥ <b>${deals.length} New Deals Alert!</b>\n\n` + deals.map((d, i) =>
          `${i + 1}. ðï¸ <b>${d.title || 'Amazon Deal'}</b>\n ð° <b>${d.price || 'Check link'}</b>\n ð <a href="${d.url}">Grab deal</a>`
        ).join('\n\n');

  const facebookMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `ð¥ New Deal Alert!\n\nðï¸ ${deals[0].title || 'Amazon Deal'}\n\nð° ${deals[0].price || 'Check link'}\n\nð ${deals[0].url}\n\n#ad #deals #amazon #dealsaholic #shopping #sale`
      : `ð¥ ${deals.length} New Deals Alert!\n\n` + deals.map((d, i) =>
          `${i + 1}. ðï¸ ${d.title || 'Amazon Deal'}\n ð° ${d.price || 'Check link'}\n ð ${d.url}`
        ).join('\n\n') + '\n\n#ad #deals #amazon #dealsaholic #shopping #sale';

  return new Response(JSON.stringify({
    success: true,
    count:   deals.length,
    ids:     savedIds,
    deals,
    productBlocksFound: blocks.length,
    telegramMessage,
    facebookMessage,
    title:    deals[0]?.title    || null,
    price:    deals[0]?.price    || null,
    url:      deals[0]?.url      || null,
    imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/submit-email-deal" };
