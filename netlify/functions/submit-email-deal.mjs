import { getStore } from "@netlify/blobs";

const PARTNER_TAG = 'kethya08-20';
const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG_ENV = process.env.AMAZON_PARTNER_TAG || PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

// ─── Amazon Creator API ────────────────────────────────────────────────────

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
    // FIX: Only use the primary large image from the API — never /images/P/ format
    const image = item.images?.primary?.large?.url || null;
    console.log(`Title search "${title}" → ASIN ${asin}, image: ${image ? 'found' : 'missing'}`);
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

// ─── Amazon page scraper ───────────────────────────────────────────────────

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
      // FIX: Return null for image when scrape fails — never use /images/P/ format
      return {
        title: null, price: null,
        image: null,
        asin: asinFromRedirect, finalUrl: redirectUrl,
      };
    }
    const finalUrl = res.url;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || asinFromRedirect || null;
    const html = await res.text();
    const title =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    // Extract image: try og:image (both attribute orderings), then data-old-hires,
    // then the data-a-dynamic-image JSON blob Amazon uses for product carousels.
    const image = (() => {
      // og:image — property before content
      let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
      if (m) return m[1];
      // og:image — content before property (reversed attribute order)
      m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (m) return m[1];
      // High-res image stored in data-old-hires on the main product image tag
      m = html.match(/data-old-hires=["']([^"']+)["']/i);
      if (m) return m[1];
      // data-a-dynamic-image is a JSON map of { url: [w,h] } — take the first key
      m = html.match(/data-a-dynamic-image=["'](\{[^"']+\})["']/i);
      if (m) {
        try {
          const parsed = JSON.parse(m[1].replace(/&quot;/g, '"'));
          const url = Object.keys(parsed)[0];
          if (url && url.startsWith('http')) return url;
        } catch (_) { /* ignore */ }
      }
      return null;
    })();
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
    // FIX: Return null for image on error — never use /images/P/ format
    return {
      title: null, price: null,
      image: null,
      asin: asinFromRedirect, finalUrl: redirectUrl,
    };
  }
}


// ─── Amazon scraper: price + image fallback ──────────────────────────────────
// Returns { price: number|null, image: string|null }
// Called when fetchAmazonMeta couldn't get price or image from the product page.

async function scrapeAmazonData(asin) {
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) return { price: null, image: null };
    const html = await res.text();

    // ── Price ──
    let price = null;
    const pricePatterns = [
      /"priceAmount"\s*:\s*"?([\d.]+)"?/,
      /"dealPrice"\s*:\s*\{"value"\s*:\s*([\d.]+)/,
      /class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)<\/span><span[^>]*class=["'][^"']*a-price-fraction[^"']*["'][^>]*>(\d+)/,
      /id=["']priceblock_dealprice["'][^>]*>\s*\$([\d,]+\.?\d*)/,
      /id=["']priceblock_ourprice["'][^>]*>\s*\$([\d,]+\.?\d*)/,
    ];
    for (const pattern of pricePatterns) {
      const m = html.match(pattern);
      if (m) {
        const v = pattern.toString().includes('price-whole')
          ? parseFloat(`${m[1].replace(/,/g,'')}.${m[2]}`)
          : parseFloat(m[1].replace(/,/g,''));
        if (!isNaN(v) && v > 0) { price = v; break; }
      }
    }

    // ── Image ──
    let image = null;
    let im = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (im) { image = im[1]; }
    if (!image) {
      im = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      if (im) image = im[1];
    }
    if (!image) {
      im = html.match(/data-old-hires=["']([^"']+)["']/i);
      if (im) image = im[1];
    }
    if (!image) {
      im = html.match(/data-a-dynamic-image=["'](\{[^"']+\})["']/i);
      if (im) {
        try {
          const parsed = JSON.parse(im[1].replace(/&quot;/g, '"'));
          const url = Object.keys(parsed)[0];
          if (url && url.startsWith('http')) image = url;
        } catch (_) { /* ignore */ }
      }
    }

    return { price, image };
  } catch (e) {
    console.error(`scrapeAmazonData(${asin}) failed:`, e.message);
    return { price: null, image: null };
  }
}

// Thin alias kept for callers that only need price
async function scrapeAmazonPrice(asin) {
  return (await scrapeAmazonData(asin)).price;
}

// ─── Text helpers ──────────────────────────────────────────────────────────

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
    .replace(/<style[^>]*>\s\S]*?<\/style>/gi, ' ')
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
  if (/here\s+is\s+a\s+list|for\s+your\s+reference|original\s+price\s+:/i.test(decoded)) return true;
  // FIX: Reject common email boilerplate phrases that are NOT product titles
  if (/save\s+\d+\s+%\s+on\s+(?:the\s+)?eligible/i.test(decoded)) return true;
  if (/terms\s+and\s+conditions|must\s+sign\s+in|redeem\s+this\s+promotion|unsubscribe|privacy\s+policy|view\s+in\s+browser|click\s+here\s+to/i.test(decoded)) return true;
  if (/you\s+must\s+|please\s+note\s+|this\s+email\s+|dear\s+customer|dear\s+friend/i.test(decoded)) return true;
  const letters = (decoded.match(/[a-zA-Z\s]/g) || []).length;
  if (decoded.length > 0 && letters / decoded.length < 0.6) return true;
  if (decoded.trim().length < 8) return true;
  return false;
}

// ─── Date parsing ──────────────────────────────────────────────────────────

function parseDateString(raw, defaultHour = '00', defaultMin = '00') {
  if (!raw) return null;
  let s = raw
    .replace(/\s*(?:PDT|PST|PST8PDT|EDT|EST|UTC|GMT)[^\s]*/gi, '')
    .replace('T', ' ')
    .trim();

  const concat = s.match(/^(\d{4})-(\d{1,2})-(\d{2})(\d{2}:\d{2})?$/);
  if (concat) {
    const [, yr, mo, dy, tm] = concat;
    const [hr, mn] = tm ? tm.split(':') : [defaultHour, defaultMin];
    const d = new Date(`${yr}-${mo.padStart(2,'0')}-${dy}T${hr.padStart(2,'0')}:${mn.padStart(2,'0')}:00Z`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

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

// ─── Price helpers ─────────────────────────────────────────────────────────

function parsePriceValue(str) {
  if (!str) return null;
  const s = str.trim().replace(/^\$/, '');
  const rangeMatch = s.match(/^([\d]+(?:\.[\d]+)?)\s*[-–]\s*([\d]+(?:\.[\d]+)?)$/);
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

// ─── Per-product block field extractor ────────────────────────────────────

function extractFieldsFromBlock(block, prevTail) {
  // ── Amazon URLs ────────────────────────────────────────────────────────────
  const dpMatch =
    block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>\n]*/i)
    || block.match(/https?:\/\/amzn\.to\/[A-Za-z0-9]+/i)
    || block.match(/https?:\/\/a\.co\/[A-Za-z0-9/]+/i);
  const realUrl = dpMatch ? dpMatch[0].replace(/["'\s]+$/, '') : null;

  const asinFromUrl = realUrl
    ? (realUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null)
    : null;

  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/promocode\/[A-Z0-9]+/i);
  const promocodeUrl = promoMatch ? promoMatch[0].replace(/\s+/g, '') : null;

  // ── Promo code ─────────────────────────────────────────────────────────────
  const codeMatch = block.match(
    /(?:discount\s*code|promo(?:tion)?\s*code|coupon\s*code|(?<![a-zA-Z])code|(?<![a-zA-Z])coupon)\s*[:：]\s*["']?([A-Z0-9]{4,20})\b/i
  );
  const promoCode = codeMatch ? codeMatch[1].toUpperCase() : null;

  // ── Coupon percentage ──────────────────────────────────────────────────────
  const couponPctMatch = block.match(/(?<![a-zA-Z])coupon\s*[:：]\\ʊ�K�JWʉK�JN�ۜ���\۔�H��\۔�X]���
��[���H	����\۔�X]��K�[��Y\���[���JH��[���\۔�X]��WJB���[���8� 8� �[H�X�H8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 8� 
  const PRICE_PATTERN = /\$?\s*([\d]+(?:\.[\d]+)?(?:\s*[-–]\s*[\d]+(?:\.[\d]+)?)?)/;
  const saleLabelRe = new RegExp(
    '(?:deal\\s*price|discount\\s*price|product\\s*price|sale\\s*price' +
    '|after\\s*(?:the\\s*)?discount\\s*price|price\\s*after\\s*discount|final\\s*price)' +
    '\\s*[:：]?\\s*' + PRICE_PATTERN.source,
    'i'
  );
  const barePriceRe = new RegExp(
    '(?:^|\\n)[ \\t]*price\\s*[:：]\\s*' + PRICE_PATTERN.source,
    'i'
  );
  const salePriceRaw = (block.match(saleLabelRe) || block.match(barePriceRe))?.[1] || null;
  let salePrice = parsePriceValue(salePriceRaw);

  // ── Original price ─────────────────────────────────────────────────────────
  const origLabelRe = new RegExp(
    '(?:original\\s*price|price\\s*before\\s*discount|list\\s*price|was' +
    '|reg(?:ular)?\\.?\\s*(?:price)?)' +
    '\\s*[:：]?\\s*' + PRICE_PATTERN.source,
    'i'
  );
  const origPriceRaw = block.match(origLabelRe)?.[1] || null;
  let origPrice = parsePriceValue(origPriceRaw);

  if (salePrice && origPrice && !salePrice.isRange && !origPrice.isRange
    && origPrice.low < salePrice.low) {
    [salePrice, origPrice] = [origPrice, salePrice];
  }

  if (!salePrice && !origPrice) {
    const amounts = [...block.matchAll(/\$\s*([\d]+\.[\d]{1,2})\b/g)]
      .map(m => parseFloat(m[1])).filter(p => p > 0);
    if (amounts.length >= 2) {
      const sorted = [...amounts].sort((a, b) => a - b);
      salePrice = parsePriceValue(String(sorted[0]));
      origPrice = parsePriceValue(String(sorted[sorted.length - 1]));
    }
  }

  // ── Discount % ─────────────────────────────────────────────────────────────
  let discount = null;

  if (prevTail) {
    const ptm = prevTail.match(/(?:discount|%off)\s*[:：]?\s*(\d{1,2})\s*%/i);
    if (ptm) discount = ptm[1];
  }

  if (!discount) {
    const dm =
      block.match(/(?:^|[\n\s])(?:discount|%off)\s*[:：]\s*(\d{1,2})\s*%/i)
      || block.match(/(\d{1,2})\s*%\s*(?:off(?:\s+prime)?|OFF(?:\s+PRIME)?)\b/i)
      || block.match(/(\d{1,2})\s*%\s*(?:discount)\b/i)
      // FIX: Also detect "Save X%" pattern within a block
      || block.match(/[Ss]ave\s+(\d{1,2})\s*%/i);
    if (dm) discount = dm[1];
  }

  if (!discount && salePrice && origPrice
    && !salePrice.isRange && !origPrice.isRange && origPrice.low > 0) {
    const pct = Math.round((1 - salePrice.low / origPrice.low) * 100);
    if (pct >= 5 && pct <= 95) discount = String(pct);
  }

  // ── Start date ─────────────────────────────────────────────────────────────
  const startRaw = block.match(
    /start\s*(?:date|day|time)?\s*[:：]?\s*([\d]{4}-[\d]{1,2}-[\d]{1,2}(?:\s*T?\s*[\d]{1,2}:[\d]{2})?)/i
  );
  const startDate = startRaw ? parseDateString(startRaw[1], '00', '00') : null;

  // ── End date ───────────────────────────────────────────────────────────────
  const endRaw = block.match(
    /end\s*(?:date|day|time)?\s*[:：]?\s*([\d]{4}-[\d]{1,2}-[\d]{1,2}(?:\s*T?\s*[\d]{1,2}:[\d]{2})?)/i
  );
  const endDateParsed = endRaw ? parseDateString(endRaw[1], '23', '59') : null;
  const endDate = (endDateParsed && new Date(endDateParsed).getTime() > Date.now())
    ? endDateParsed : null;

  return {
    asinFromUrl,
    realUrl,
    promocodeUrl,
    promoCode,
    couponPct,
    discount,
    salePrice: formatPrice(salePrice),
    originalPrice: formatPrice(origPrice),
    startDate,
    endDate,
  };
}

// ─── Title extraction ──────────────────────────────────────────────────────

const FIELD_LINE_RE = /^(?:original\s*price|price\s*before|deal\s*price|discount\s*price|product\s*price|sale\s*price|after\s*the\s*discount|final\s*price|code\s*[:：]|coupon\s*[:：]|promo|link\s*[:：]|start\s*(?:date|day|time)|end\s*(?:date|day|time)|%off|discount\s*[:：]|\d+\s*%|https?:\/\/|us\d+\s+creator|creator\s+campaign|campaign\s*id|dear\s+friend|today\s+we)/i;

function extractTitleFromBlock(blockText, strategy) {
  const lines = blockText.split('\n').map(l => l.trim()).filter(Boolean);

  if (strategy === 'label') {
    const firstLine = lines[0] || '';
    const inlineFieldMatch = firstLine.match(
      /\b(?:original\s*price|price\s*before|deal\s*price|discount\s*price|product\s*price|sale\s*price|after\s*(?:the\s*)?discount|code\s*[:：]|coupon\s*[:：]|link\s*[:：]|start\s*date|end\s*(?:date|day)|%off\s*[:：]|\d+\s*%\s*off)/i
    );
    const raw = inlineFieldMatch
      ? firstLine.slice(0, inlineFieldMatch.index)
      : firstLine;
    const title = raw.replace(/^["""'\s]+|["""'",：\s]+$/g, '').substring(0, 200);
    if (title.length > 4 && !isGarbageText(title)) return title;
  }

  if (strategy === 'numbered') {
    for (const line of lines.slice(1, 4)) {
      const m = line.match(/^["""']?(?:products?\s*(?:name|title)|title)\s*[:：]\s*(.+)/i);
      if (m) {
        const title = m[1].replace(/^["""'\s]+|["""'",：\s]+$/g, '').substring(0, 200);
        if (!isGarbageText(title)) return title;
      }
    }
    for (const line of lines.slice(1)) {
      if (!FIELD_LINE_RE.test(line) && !/^https?:\/\//i.test(line)
        && line.length > 10 && !isGarbageText(line)) {
        return line.replace(/^["""'\s]+|["""'",：\s]+$/g, '').substring(0, 200);
      }
    }
  }

  // Fallback: scan all lines for an explicit title label
  for (const line of lines) {
    const m = line.match(/^["""']?(?:products?\s*(?:name|title)|title)\s*[:：]\s*(.+)/i);
    if (m) {
      const title = m[1].replace(/^["""'\s]+|["""'",：\s]+$/g, '').substring(0, 200);
      if (!isGarbageText(title)) return title;
    }
  }

  // FIX: In 'fallback' strategy, only return a title if there's also a real Amazon URL
  // in the block — prevents treating email boilerplate as a product title.
  if (strategy === 'fallback') {
    const hasAmazonUrl = /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(blockText);
    if (!hasAmazonUrl) return null;
  }

  // Last resort: first meaningful line that is not a field label or URL
  for (const line of lines) {
    if (!FIELD_LINE_RE.test(line) && !/^https?:\/\//i.test(line)
      && line.length > 10 && !isGarbageText(line)) {
      return line.replace(/^["""'\s]+|["""'",：\s]+$/g, '').substring(0, 200);
    }
  }

  return null;
}

// Extracts Amazon product URLs from raw HTML that uses redirect/tracking links.
// Amazon promotional emails ("Save XX% on eligible item(s)") embed the real
// product URL URL-encoded inside a gp/r.html redirect or a clicks.em.amazon.com
// tracking link, e.g.:
//   href="https://www.amazon.com/gp/r.html?...&amp;U=https%3A%2F%2Fwww.amazon.com%2Fdp%2FB0ABC123..."
// After stripHtmlKeepLines() those href values are lost entirely.
// This function pulls ASINs out of the raw HTML BEFORE stripping so Strategy 0
// can find them.
function extractAmazonUrlsFromHtml(html) {
  const urls = [];
  const seen = new Set();

  function addAsin(asin) {
    if (!asin || seen.has(asin)) return;
    seen.add(asin);
    urls.push(`https://www.amazon.com/dp/${asin.toUpperCase()}`);
  }

  // --- Strategy A: href with gp/r.html?...&U=<encoded-product-url> ---
  const hrefPattern = /href=["']([^"']{20,})["']/gi;
  for (const m of html.matchAll(hrefPattern)) {
    const href = m[1].replace(/&amp;/g, '&');

    if (/amazon\.com\/gp\/r[\.\?]/i.test(href)) {
      try {
        const u = new URL(href);
        const productUrl = u.searchParams.get('U');
        if (productUrl) {
          const decoded = decodeURIComponent(productUrl);
          const asin = decoded.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]
            || decoded.match(/\/gp\/product\/([A-Z0-9]{10})/i)?.[1];
          if (asin) { addAsin(asin); continue; }
        }
      } catch (_) {}
    }

    // Direct ASIN in href
    const asin = href.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]
      || href.match(/\/gp\/product\/([A-Z0-9]{10})/i)?.[1];
    if (asin) addAsin(asin);
  }

  // --- Strategy B: URL-encoded /dp%2FASIN inside query strings ---
  for (const m of html.matchAll(/\/dp%2F([A-Z0-9]{10})/gi)) addAsin(m[1]);

  // --- Strategy C: clicks.em.amazon.com tracking links (resolved later) ---
  for (const m of html.matchAll(/https?:\/\/clicks\.em\.amazon\.com\/[^\s"'<>]+/gi)) {
    if (!seen.has(m[0])) { seen.add(m[0]); urls.push(m[0]); }
  }

  if (urls.length > 0) {
    console.log(`[extractAmazonUrlsFromHtml] found ${urls.length} URL(s) in raw HTML`);
  }
  return urls;
}

// ─── Block splitting ───────────────────────────────────────────────────────

function splitAtPositions(text, positions) {
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  return sorted.map((start, i) => ({
    blockText: text.slice(start, sorted[i + 1] ?? text.length).trim(),
    prevTail: text.slice(0, start).slice(-200),
  }));
}

// Split the email into isolated per-product blocks.
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

  // ── Strategy 0: Amazon "Save X% on eligible items" multi-product format ──
  // Handles: "Save 40% on the eligible item(s) below"
  // Extracts ALL /dp/ASIN product URLs and applies the global discount to each.
  // This runs FIRST so multi-product promo emails never fall through to
  // strategies 3/4 which would misread email boilerplate as product titles.
  const eligibleMatch = text.match(/[Ss]ave\s+(\d{1,2})\s*%\s+on\s+(?:the\s+)?eligible/i);
  if (eligibleMatch) {
    const globalDiscount = eligibleMatch[1];
    // Extract a global promo code if present anywhere in the email
    const globalCodeMatch = text.match(
      /(?:discount\s*code|promo(?:tion)?\s*code|coupon\s*code|(?<![a-zA-Z])code)\s*[:：]\s*["']?([A-Z0-9]{4,20})\b/i
    );
    const globalCode = globalCodeMatch ? globalCodeMatch[1].toUpperCase() : null;
    // Collect all unique /dp/ASIN or /gp/product/ASIN URLs
    const allUrlMatches = [
      ...text.matchAll(/https?:\/\/(?:www\.)?amazon\.com\/(?:[^\s"'<>\n]*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>\n]*/gi)
    ];
    const seenAsins0 = new Set();
    for (const m of allUrlMatches) {
      const asinFromUrl = m[1].toUpperCase();
      if (seenAsins0.has(asinFromUrl)) continue;
      seenAsins0.add(asinFromUrl);
      const realUrl = m[0].replace(/["'\s]+$/, '');
      results.push({
        title: null,          // fetched from Amazon API in main handler
        asinFromUrl,
        realUrl,
        promocodeUrl: null,
        promoCode: globalCode,
        couponPct: null,
        discount: globalDiscount,
        salePrice: null,
        originalPrice: null,
        startDate: null,
        endDate: null,
      });
    }
    if (results.length > 0) {
      console.log(`[Strategy 0] "Save ${globalDiscount}% eligible items" — ${results.length} product URL(s) found`);
      return results.slice(0, 20);
    }
    // If no /dp/ URLs found in an "eligible items" email, stop here.
    // Do not fall through to strategies that would misread boilerplate.
    console.log(`[Strategy 0] "Save ${globalDiscount}% eligible items" email but no /dp/ URLs found — skipping`);
    return results;
  }

  // ── Strategy 1: Split on title label markers ───────────────────────────────
  const TITLE_LABEL_RE = /(?:products?\s*(?:name|title)|(?<![a-zA-Z])title)\s*[:：]/gi;
  const titleMatches = [...text.matchAll(TITLE_LABEL_RE)];

  if (titleMatches.length > 0) {
    const segs = splitAtPositions(text, titleMatches.map(m => m.index + m[0].length));
    for (const { blockText, prevTail } of segs) {
      addBlock(blockText, prevTail, 'label');
    }
    if (results.length > 0) return results.slice(0, 20);
  }

  // ── Strategy 2: Split on numbered list prefixes at line start ──────────────
  const NUMBERED_RE = /(?:^|\n)[ \t]*\d+\s*[.、]/gm;
  const numMatches = [...text.matchAll(NUMBERED_RE)];

  if (numMatches.length > 0) {
    const positions = numMatches.map(m => m.index + (text[m.index] === '\n' ? 1 : 0));
    const segs = splitAtPositions(text, positions);
    for (const { blockText, prevTail } of segs) {
      addBlock(blockText, prevTail, 'numbered');
    }
    if (results.length > 0) return results.slice(0, 20);
  }

  // ── Strategy 3: Split on double blank lines ────────────────────────────────
  // FIX: Only create blocks that contain a real Amazon product URL.
  // This prevents email boilerplate paragraphs from becoming fake deals.
  const blankParts = text.split(/\n{2,}/);
  if (blankParts.length > 1) {
    let offset = 0;
    for (const part of blankParts) {
      const trimmed = part.trim();
      const prevTail = text.slice(0, offset).slice(-200);
      // Only process paragraphs that have an actual Amazon /dp/ product URL
      if (trimmed.length >= 10 && /https?:\/\/(?:www\.)?amazon\.com\/(?:[^\s"'<>\n]*\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(trimmed)) {
        addBlock(trimmed, prevTail, 'fallback');
      }
      offset += part.length + 2;
    }
    if (results.length > 0) return results.slice(0, 20);
  }

  // ── Strategy 4 REMOVED ────────────────────────────────────────────────────
  // Treating the whole email as one product block caused email boilerplate
  // (e.g. "Save 40% on the eligible item(s) below. Terms and conditions…")
  // to be saved as a product title. Strategy 0 now handles these emails.
  return results;
}

// ─── Deduplication helpers ─────────────────────────────────────────────────
// Three indexes live in the submissions blob store:
//   asin-index        : { [ASIN]: submissionId }
//   url-index         : { [normalizedUrl]: submissionId }
//   asin-promo-index  : { ["ASIN|PROMOCODE"]: submissionId }

function normalizeUrlForIndex(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return url.toLowerCase().trim();
  }
}

async function loadDedupIndexes(store) {
  let asinIndex = {}, urlIndex = {}, asinPromoIndex = {};
  try { asinIndex      = await store.get('asin-index',       { type: 'json' }) || {}; } catch {}
  try { urlIndex       = await store.get('url-index',        { type: 'json' }) || {}; } catch {}
  try { asinPromoIndex = await store.get('asin-promo-index', { type: 'json' }) || {}; } catch {}
  return { asinIndex, urlIndex, asinPromoIndex };
}

async function saveDedupIndexes(store, asinIndex, urlIndex, asinPromoIndex) {
  await store.setJSON('asin-index',       asinIndex);
  await store.setJSON('url-index',        urlIndex);
  await store.setJSON('asin-promo-index', asinPromoIndex);
}

// Returns { isDuplicate, reason, existingId } or { isDuplicate: false }
function checkDuplicate(asin, affiliateUrl, promoCode, asinIndex, urlIndex, asinPromoIndex) {
  if (asin && asinIndex[asin]) {
    return { isDuplicate: true, reason: 'ASIN', existingId: asinIndex[asin] };
  }
  const normUrl = normalizeUrlForIndex(affiliateUrl);
  if (normUrl && urlIndex[normUrl]) {
    return { isDuplicate: true, reason: 'URL', existingId: urlIndex[normUrl] };
  }
  if (asin && promoCode) {
    const key = `${asin}|${promoCode.toUpperCase()}`;
    if (asinPromoIndex[key]) {
      return { isDuplicate: true, reason: 'ASIN+PromoCode', existingId: asinPromoIndex[key] };
    }
  }
  return { isDuplicate: false };
}

function registerInDedupIndexes(id, asin, affiliateUrl, promoCode, asinIndex, urlIndex, asinPromoIndex) {
  if (asin) asinIndex[asin] = id;
  const normUrl = normalizeUrlForIndex(affiliateUrl);
  if (normUrl) urlIndex[normUrl] = id;
  if (asin && promoCode) asinPromoIndex[`${asin}|${promoCode.toUpperCase()}`] = id;
}

// ─── Main handler ──────────────────────────────────────────────────────────

export default async (req, context) => {
  const urlObj = new URL(req.url);
  const debugMode = urlObj.searchParams.get('debug') === 'true';
  // force=true → bypass dedup checks so you can reprocess an email without creating duplicates
  // being rejected. Existing records are NOT overwritten — duplicates are logged, not saved again.
  // Use force=true only for testing; in production every email is processed once.
  const forceMode = urlObj.searchParams.get('force') === 'true';
  // messageId helps trace logs back to the originating email
  let messageId = urlObj.searchParams.get('messageId') || null;

  let emailBody = '', title = '', snippet = '';

  if (req.method === 'GET') {
    emailBody = urlObj.searchParams.get('emailBody') || '';
    title = urlObj.searchParams.get('title') || '';
    snippet = urlObj.searchParams.get('snippet') || '';
  } else if (req.method === 'POST') {
    try { emailBody = await req.text(); } catch (e) { emailBody = ''; }
  }

  let content = (emailBody || title).trim();

  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.emailBody) content = String(parsed.emailBody);
      else if (parsed.snippet) content = String(parsed.snippet);
      // Allow messageId to be passed in the JSON body too
      if (parsed.messageId && !messageId) messageId = String(parsed.messageId);
    }
  } catch (e) {}

  content = maybeUrlDecode(content);
  const lineText = stripHtmlKeepLines(content);

  // Amazon promotional emails ("Save XX% on eligible item(s)") embed product
  // URLs inside HTML redirect/tracking links (gp/r.html?...&U=<encoded-url>).
  // Those href values are stripped by stripHtmlKeepLines, so Strategy 0 in
  // parseEmailIntoProductBlocks finds zero /dp/ASIN URLs and returns empty.
  // Fix: extract the real product URLs from the raw HTML, then append them to
  // lineText as plain-text lines so Strategy 0 can find and process them.
  const htmlProductUrls = extractAmazonUrlsFromHtml(content);
  const enrichedLineText = htmlProductUrls.length > 0
    ? lineText + '\n\n' + htmlProductUrls.join('\n')
    : lineText;

  const blocks = parseEmailIntoProductBlocks(enrichedLineText);
  console.log(`[Parser] email="${messageId || 'unknown'}" blocks=${blocks.length} debug=${debugMode} force=${forceMode}`);

  // ── Debug mode: return JSON preview, no saves ──────────────────────────────
  if (debugMode) {
    const preview = blocks.map(block => ({
      title: block.title || null,
      asin: block.asinFromUrl || null,
      originalPrice: block.originalPrice || null,
      salePrice: block.salePrice || null,
      discount: block.discount ? `${block.discount}%` : null,
      promoCode: block.promoCode || null,
      couponPct: block.couponPct ? `${block.couponPct}%` : null,
      amazonUrl: block.realUrl || block.promocodeUrl || null,
      imageUrl: null,
      startDate: block.startDate || null,
      endDate: block.endDate || null,
  ������������(���������ͥ�5��ͥ��者�������ͥ�ɽ�Uɰ�������������ɽ������Uɰ�(�����������Aɽ������耄��������ɽ������Uɰ�(��������(��������(����ɕ��ɸ���܁I�����͔�)M=8���ɥ�����쁑��՜���Ք�����ͅ��%�����չ�聉����̹����Ѡ���������ɕ٥�܁����ձ���Ȥ���(�������х��������(��������������쀝
��ѕ�еQ����耝�������ѥ����ͽ�����(�������(���((������R�R �9�ɵ�������聕�ɥ����م����є���������ٔͅ�Ѽ�	���̰��ՕՔ����ɽٕ������̃�R (������Ё�ѽɔ�􁝕�Mѽɔ���Չ���ͥ��̈��(������Ё�ՕՕMѽɔ�􁝕�Mѽɔ��������ՕՔ���(������Ёٕͅ�%�̀�mt�(������Ёͭ�����������ѕ̀�mt�(������Ё����̀�mt�(������Ё�ՕՕ%ѕ�̀�mt�(������Ё͕��ͥ�̀􁹕܁M�Р�쀀���������ݥѡ���ѡ�́�����((�����1�����ɽ�̵�����������������́���������ɔ�ѡ������(������Ё쁅ͥ�%���ఁ�ɱ%���ఁ�ͥ�Aɽ��%�������݅�Ё��������%����̡�ѽɔ��(����Ё�����%��������􁙅�͔쀀��������ɥє������́���ͽ��ѡ����ٕ݅́ͅ�((����Ȁ�����Ё��������������̤��(������Ё�������ѕUɰ�􀜜�(������Ё�����Uɰ��ձ��(������Ё����Q�ѱ��􁉱����ѥѱ��(������Ё�ͥ���ձ��(������Ё�х��̀����������(������Ё�ɥ��ɽ�5�ф��ձ�쀀�����ɥ���͍Ʌ�����ɽ����齸��ɽ�ՍЁ����((��������R�R �
M���I����������Ȁ�����ɽ�Սм�UI0��P�M%8��́���ݸ��R�R�R�R�R�R�R�R�R�R�R�R�R�R�R (��������������ɕ��Uɰ���(���������ͽ��������m�����������ͅ��%��um	����t�ɕ���UI0��ͥ���퉱�����ͥ�ɽ�Uɰ���������ɰ��퉱����ɕ��Uɱ����(����������Ё��ф��݅�Ё��э���齹5�ф�������ɕ��Uɰ��(�������ͥ��􁉱�����ͥ�ɽ�Uɰ������ф���ͥ������ձ��(�������������ѕUɰ��ͥ�(����������������輽��ܹ���齸����������ͥ���х����AIQ9I}Q��(��������耡������ɕ��Uɰ�����Ց�̠�х����(������������������ɕ��Uɰ(����������聀�퉱����ɕ��Uɱ��퉱����ɕ��Uɰ�����Ց�̠�����������耜���х����AIQ9I}Q����(���������%`�%���������́�ɽ����齸�͍Ʌ������䃊P���ٕȀ������̽@����������(�����������Uɰ�􁵕ф������������ձ��(����������Q�ѱ��􀡵�ф��ѥѱ���������ɉ���Q��С��ф�ѥѱ�������ф�ѥѱ��聹ձ��(�����������������ѥѱ�(������������ձ��(���������
����ɔ��ɥ����ɽ��ѡ��͍Ʌ������齸�����(�������ɥ��ɽ�5�ф�􁵕ф���ɥ�������ձ��(�����������ͥ������������ѕUɰ���������Uɰ��������Q�ѱ���������ɉ���Q��С����Q�ѱ�����х��̀􀝅��ɽٕ���(���������ͽ��������m�����������ͅ��%��um	����t��ͥ����ͥ�􁥵�����������Uɰ����eL��耝�����ɥ����퉱����ͅ��Aɥ�������ɥ��ɽ�5�ф������������͍�չЁ����������ѥѱ���M�ɥ�������Q�ѱ����������Չ��ɥ���������􉀤�(�����((��������R�R �
M��耽�ɽ��������UI0��P�M%8�չ���ݸ��R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R (�������%`�Q��͔��ɔ�ͭ��������ѥɕ�䁉���ɥ�Ёم����ѥ�������܀����M%8������������(�����������Ёٔͅ����ѥ���ɕ��ɑ�쁅����������Ёɕ�����䁙���ѡ���(������͔������������ɽ������Uɰ���(���������ͽ��������m�����������ͅ��%��um	����t�M-%@��ɽ�������UI0�����M%8�耑퉱�����ɽ������Uɱ����(���������1��ٔ��ͥ���ձ��������Uɰ��ձ�������Q�ѱ��������ѥѱ���P�م����ѥ���ݥ���ͭ���(�����((��������R�R �
M���Q�ѱ�����䃊P�͕�ɍ����齸���ѥѱ���R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R (������͔�����������ѥѱ����(���������ͽ��������m�����������ͅ��%��um	����t����UI0��P�͕�ɍ�������齸���ѥѱ�耈�퉱����ѥѱ�􉀤�(����������Ё͕�ɍ�I��ձЀ�݅�Ё͕�ɍ���齹	�Q�ѱ��������ѥѱ���(����������͕�ɍ�I��ձФ��(���������ͥ���͕�ɍ�I��ձй�ͥ��(���������������ѕUɰ��͕�ɍ�I��ձй�ɰ�(�����������%`聥������ɽ��͕�ɍ���齹	�Q�ѱ����ɕ���ɕ��ɹ́�ձ�����ѕ������������̽@�(�������������Uɰ��͕�ɍ�I��ձй������(������������Q�ѱ��􁉱����ѥѱ��(�������������ͥ������������ѕUɰ���������Uɰ��������ɉ���Q��С����Q�ѱ�����х��̀􀝅��ɽٕ���(�����������ͽ��������m�����������ͅ��%��um	����t�ѥѱ��͕�ɍ���ͥ����ͥ�􁥵�����������Uɰ����eL��耝�������(������􁕱͔��(�����������ͽ��������m�����������ͅ��%��um	����t�ѥѱ��͕�ɍ��ɕ��ɹ������ɕ�ձЁ��Ȁ��퉱����ѥѱ�􉀤�(�������(�����(((��������R�R ���������͍Ʌ�����齸�ݡ����ɥ����ȁ�������́���ͥ����R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R (�������!�����́�ɥ���Ʌ���̀���������и�����䈤�����ͥ���ͅ����ɥ�����ȁ���ͥ��(�������������������������ݡ�����齸������́��饵�������ѡ������Ё��э���(��������Ё�����Aɥ����ͥ������������ͅ��Aɥ��������ɥ��ɽ�5�ф�(��������Ё�����%������ͥ�����������Uɰ�(�������������Aɥ�����������%�������(���������ͽ��������m�����������ͅ��%��um	����t�͍Ʌ�������齸���ȁM%8���ͥ���ɥ����������Aɥ��􁥵�����������%���������(����������Ё͍Ʌ�����݅�Ё͍Ʌ����齹�ф��ͥ���((���������������%��������͍Ʌ������������(�������������Uɰ��͍Ʌ����������(�����������ͽ��������m�����������ͅ��%��um	����t�͍Ʌ������������ȁM%8���ͥ�����(�������((���������������Aɥ������͍Ʌ�����ɥ������ձ����(���������ɥ��ɽ�5�ф�􁀐��͍Ʌ�����ɥ���ѽ�ᕐ�ȥ���(�����������ͽ��������m�����������ͅ��%��um	����t�͍Ʌ�����ɥ������ɥ��ɽ�5�х􁙽ȁM%8���ͥ�����(�����������I�����ձ�є���͍�չЁ�ɽ���ɥ�������ɥ��������Ё��ɕ���͕�(���������������������͍�չЀ����������ɥ�����Aɥ�����(��������������Ё�ɥ�M�Ȁ􁉱�����ɥ�����Aɥ���ɕ�������yp���������ɥ����(��������������ЁɅ���4��ɥ�M�ȹ��э���x�mq��t��q̩l��Muq̨�mq��t������(��������������Ё�ɥ�Y��Ք��Ʌ���4������͕���СɅ���5l�t������͕���С�ɥ�M�Ȥ�(�����������������9�8��ɥ�Y��Ք������ɥ�Y��Ք���͍Ʌ�����ɥ�������ɥ�Y��Ք�������(����������������Ё��Ѐ�5�Ѡ�ɽչ���Ā��͍Ʌ�����ɥ������ɥ�Y��Ք���������(������������������Ѐ��Ԁ�����Ѐ���Ԥ��(����������������������͍�չЀ�M�ɥ�����Ф�(�����������������ͽ��������m�����������ͅ��%��um	����t���͍�չ������������ɥ������ɥ�Y��Օ�͍Ʌ�������͍Ʌ�����ɥ�������(�������������(�����������(���������(�������((���������I���م�Յє��х��́��܁ѡ�Ёݔ���䁡�ٔ������������ȁ�ɥ��(�����������ͥ������������ѕUɰ���������Uɰ��������Q�ѱ���������ɉ���Q��С����Q�ѱ�����х��̀􀝅��ɽٕ���(�����((��������R�R �M�����������є�M%9́ݥѡ���ѡ��ͅ����������R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R (���������ͥ�����͕��ͥ�̹��̡�ͥ�����(���������ͽ��������m�����������ͅ��%��umM-%At�M�����������������є�M%8���ͥ�����(���������ѥ�Ք�(�����(���������ͥ���͕��ͥ�̹�����ͥ���((��������R�R �
ɽ�̵�������������������R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R�R (�������
��������ѡ�́M%8���UI0���M%8��ɽ�����ɕ��䁕���́���ѡ���Չ���ͥ��́�ѽɔ�(�������A��́��ɍ����Ք����ѡ���Օ����ɥ���Ѽ�ͭ���ѡ�́��������ɥ���ѕ�ѥ���(�����������ɍ�5������(����������Ё����􁍡���������є��ͥ����������ѕUɰ���������ɽ��
��������ձ����ͥ�%���ఁ�ɱ%���ఁ�ͥ�Aɽ��%�����(����������������������є���(�����������ͽ�������(�����������m�����������ͅ��%��umM-%@�UAt�������є��䀑����ɕ�ͽ��P����(������������ͥ����ͥ����ѥ��%����������ѥ��%��ѥѱ���M�ɥ�������Q�ѱ����������Չ��ɥ����������(����������(��������ͭ�����������ѕ̹��͠�쁅ͥ���ɕ�ͽ�聑���ɕ�ͽ������ѥ��%�聑������ѥ��%�����(�����������ѥ�Ք�(�������(����􁕱͔������ͥ����(�����������ɍ������聱���ѡ�Ёݔ�ɔ�����ɥ���ѡ�������������(����������Ё����􁍡���������є��ͥ����������ѕUɰ���������ɽ��
��������ձ����ͥ�%���ఁ�ɱ%���ఁ�ͥ�Aɽ��%�����(����������������������є���(�����������ͽ�������(�����������m�����������ͅ��%��um=I
t�=ٕ�ɥ������������є��䀑����ɕ�ͽ��P����(������������ͥ����ͥ����ѥ��%����������ѥ��%�􀡙�ɍ����Ք��9=P�ɔ�ͅ٥����(����������(�����������ٕ��ݥѠ���ɍ����Ք�ݔ�����Ёɔ�ٔͅ��P�ѡ���������ɕ��䁕���̸(�������������ɍ����Ք����Ё����̀�����Ё��ɽȰ�������ɽ���ͥ���ѡ��ɕ�Ё���ѡ���������(��������ͭ�����������ѕ̹��͠�쁅ͥ���ɕ�ͽ�聑���ɕ�ͽ������ѥ��%�聑������ѥ��%�����ɍ�����Ք����(�����������ѥ�Ք�(�������(�����((��������R�R �Y1%Q%=8�M%8���ѥѱ����UI0����ɥ�����͍�չЁɕ�եɕ���Ё�Չ��Ёѥ����R (�������%������́9=P�ɕ�եɕ����ɔ��P����е�ՕՕ���������́��́��ɔ�ɽ���Ё�����(���������э�������ձѥ����͍Ʌ�������ѡ��̀��Hȁ������������ݥ���ɔ���э���Ё���Ёѥ���(�������I��եɥ�����������ɔ�ݽձ��������م��������́ݡ�����齸�ѕ���Ʌɥ�����́ѡ��͍Ʌ��ȸ(��������Ё���Aɥ��=��͍�չЀ􀄄�������ͅ��Aɥ��������������͍�չЁ����ɥ��ɽ�5�ф��(��������Ё���Y����Q�ѱ��􀄄�����Q�ѱ���������ɉ���Q��С����Q�ѱ����(����������ͥ���������Y����Q�ѱ�������������ѕUɰ��������Aɥ��=��͍�չФ��(���������ͽ�������(���������mM-%At�5��ͥ���ɕ�եɕ��������̤��P����(����������ͥ���섅�ͥ��ѥѱ�������Y����Q�ѱ���ɰ��섅�������ѕUɱ􁀀�(����������ɥ��������Aɥ��=��͍�չ�􁀀�(����������P����M�ɥ�������Q�ѱ����������Չ��ɥ����������(��������(���������ѥ�Ք�(�����((��������Ё���􀝕����������є���ܠ����������5�Ѡ�Ʌ�������ѽM�ɥ����ؤ�ͱ����Ȱ�ؤ�((��������Ё�Չ���ͥ�����(���������(�������ͥ������������������������������@��ѽɕ��ͼ��������������е�ՕՕ������������͔���(������ѥѱ�聑���Q�ѱ��(�������ɥ��聉�����ͅ��Aɥ�������ɥ��ɽ�5�ф�����ձ��(�������ɥ�����Aɥ��聉������ɥ�����Aɥ�������ձ��(��������͍�չ�聉�������͍�չЁ����ձ��(�������ɰ聅������ѕUɰ�(�����������Uɰ�(��������͍�չ�
���聉������ɽ��
��������ձ��(������������A��聉�����������A�Ё����ձ��(������ͽ�ɍ�耉�������(������ͽ�ɍ�5��ͅ��%�聵��ͅ��%������ձ���������@�ݡ����������ѡ�́������ɽ�(�������х��̰(�������ͥ�5��ͥ��聙��͔�(����������ͽɕ�聙��͔�(�������ɕ�ѕ��聹�܁�є���ѽ%M=M�ɥ�����(�������х���є聉������х���є�����ձ��(����������ɕ�=�聉���������є������܁�є��є���ܠ����܀���Ѐ������������������ѽ%M=M�ɥ�����(������((�����݅�Ё�ѽɔ�͕�)M=8������Չ���ͥ����((�������I����ѕȁ��������������́�������ѕ��ͼ��Չ͕�Օ�Ё�����́���ѡ��ͅ�������(�����������Ё�ɕ�є��������ѕ́��ȁѡ��ͅ���M%8��ͅ���䁹�Ё���ѽ�����͕��ͥ�̤�(����ɕ���ѕ�%�����%����̡�����ͥ����������ѕUɰ���������ɽ��
��������ձ����ͥ�%���ఁ�ɱ%���ఁ�ͥ�Aɽ��%�����(���������%�����������Ք�((���console.log(`[email=${messageId}][SAVED] id=${id} asin=${asin} status=${status} title="${String(dealTitle || '').substring(0, 50)}"`);

    savedIds.push(id);
    deals.push({ id, title: dealTitle, price: block.salePrice || priceFromMeta || null, url: affiliateUrl, imageUrl });

    if (status === 'approved') {
      queueItems.push({
        id,
        title: dealTitle,
        price: block.salePrice || priceFromMeta || null,
        originalPrice: block.originalPrice || null,
        discount: block.discount || null,
        url: affiliateUrl,
        imageUrl,
        promoCode: block.promoCode || null,
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

  // Flush dedup indexes once after the loop (single write, not per-deal)
  if (dedupIndexDirty) {
    try {
      await saveDedupIndexes(store, asinIndex, urlIndex, asinPromoIndex);
      console.log(`[email=${messageId}][Dedup] indexes saved (${savedIds.length} new deals, ${skippedDuplicates.length} duplicates skipped)`);
    } catch (e) {
      console.error(`[email=${messageId}][Dedup] index save failed:`, e.message);
    }
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
      ? `<b>New Deal Alert!</b>\n\n<b>${deals[0].title}</b>\n\nPrice: <b>${deals[0].price || 'Check link'}</b>\n\n<a href="${deals[0].url}">Grab this deal!</a>`
      : `<b>${deals.length} New Deals Alert!</b>\n\n` + deals.map((d, i) =>
        `${i + 1}. <b>${d.title}</b>\n   Price: <b>${d.price || 'Check link'}</b>\n   <a href="${d.url}">Grab deal</a>`
      ).join('\n\n');

  const facebookMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `New Deal Alert!\n\n${deals[0].title}\n\nPrice: ${deals[0].price || 'Check link'}\n\nShop now: ${deals[0].url}\n\n#ad #deals #amazon #dealsaholic #shopping #sale`
      : `${deals.length} New Deals Alert!\n\n` + deals.map((d, i) =>
        `${i + 1}. ${d.title}\n   Price: ${d.price || 'Check link'}\n   Shop now: ${d.url}`
      ).join('\n\n') + '\n\n#ad #deals #amazon #dealsaholic #shopping #sale';

  return new Response(JSON.stringify({
    success: true,
    count: deals.length,
    ids: savedIds,
    deals,
    productBlocksFound: blocks.length,
    duplicatesSkipped: skippedDuplicates.length,
    duplicates: skippedDuplicates,
    messageId: messageId || null,
    telegramMessage,
    facebookMessage,
    title: deals[0]?.title || null,
    price: deals[0]?.price || null,
    url: deals[0]?.url || null,
    imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/submit-email-deal" };
