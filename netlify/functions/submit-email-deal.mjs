import { getStore } from "@netlify/blobs";

const AFFILIATE_TAG = process.env.AMAZON_PARTNER_TAG || 'daholic-20';

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// HTML / TEXT UTILITIES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function htmlToTextWithLines(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(?:p|div|tr|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractCdnImages(html) {
  const patterns = [
    /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/images-na\.ssl-images-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/images\.amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/[a-z0-9-]+\.ssl-images-amazon\.com\/images\/[A-Za-z0-9%._/-]+\.(?:jpg|jpeg|png|webp)/gi,
    /https:\/\/ecx\.images-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi,
  ];
  const seen = new Set();
  const images = [];
  for (const pat of patterns) {
    for (const url of (html.match(pat) || [])) {
      const clean = url.split('?')[0];
      if (!seen.has(clean) && !/_SL75_|_SS40_|thumbnail/i.test(clean)) {
        seen.add(clean);
        images.push(clean);
      }
    }
  }
  return images;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// AMAZON URL / ASIN UTILITIES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function extractAmazonUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.to\/[^\s"'<>)]+/gi,
    /https?:\/\/amzn\.com\/[^\s"'<>)]+/gi,
    /https?:\/\/a\.co\/[^\s"'<>)]+/gi,
    /https?:\/\/deals\.amazon\.com\/[^\s"'<>)]+/gi,
  ];
  const seen = new Set();
  const urls = [];
  for (const pat of patterns) {
    for (const url of (text.match(pat) || [])) {
      const clean = url.replace(/[)>\s'"]+$/, '');
      if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
    }
  }
  return urls;
}

function splitProductBlocks(text) {
  const patterns = [
    /(?:^|\n)\s*#?\s*\d+\s*:\s*(?=\n|$)/g,
    /(?:^|\n)\s*#\s*\d+\s*(?:\n|$)/g,
    /(?:^|\n)\s*\d+\s+Product\s*[Nn]ame\s*:/g,
    /(?:^|\n)\s*\d+[.)]\s*(?:\n|$)/g,
    // Most seller feeds use a field label instead of a numeric heading.
    // Splitting here keeps every following field isolated to that product.
    /(?:^|\n)\s*(?:\d+\s*[#、.)]\s*)?(?:Product\s*)?(?:Name|Title)\s*[:：]/gi,
    // Some feeds start each card with the discount and product name, e.g.
    // "65%OFF Scarlet Darkness Women Corset Midi Dress".
    /(?:^|\n)\s*(?:\d+\s*#\s*\n\s*)?\d{1,2}\s*%\s*off\s+(?!Code\b)[^\n]+/gi,
  ];
  const starts = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) starts.add(match.index);
  }
  const positions = [...starts].sort((a, b) => a - b);
  return positions.map((start, i) =>
    text.slice(start, positions[i + 1] ?? text.length).trim()
  ).filter(block => block.length > 10);
}

// Some seller feeds put the product name, discount, code, and price on one
// line. Keep the product-name portion only; the other fields are extracted
// independently below.
function cleanProductTitle(title) {
  return String(title || '')
    .replace(/\s+\d{1,2}\s*%\s*off\b[\s\S]*$/i, '')
    .replace(/\s+(?:(?:promo|discount)\s+)?code\s*[:：]\s*[A-Z0-9]{4,20}\b[\s\S]*$/i, '')
    .replace(/\s+\$?\d+(?:\.\d{2})?(?:\s*[-–]\s*\$?\d+(?:\.\d{2})?)?\s*\(Reg\.?\s*\$?[\d.\-]+\)[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractStructuredProductData(block) {
  const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let titleLine = lines.findIndex(line => /^(?:Product\s*)?(?:[Nn]ame|[Tt]itle)\s*[:：]/.test(line));
  const isHeaderOnly = /^(?:Code\s+(?:End|Start)\s+Date|(?:Great\s+)?Amazon\s+promo\s+deals|\d{1,2}[./-]\d{1,2}\s+Deals)\b/i.test(lines[0] || '');
  let title = null;
  if (!isHeaderOnly && titleLine < 0) {
    // Title-first seller format: "52% off ANRABESS Midi Dresses".
    titleLine = lines.findIndex(line => /^\d{1,2}\s*%\s*off\b/i.test(line));
  }
  if (!isHeaderOnly && titleLine >= 0) {
    const titleLines = [lines[titleLine]
      .replace(/^(?:Product\s*)?(?:[Nn]ame|[Tt]itle)\s*[:：]\s*/i, '')
      .replace(/^\d{1,2}\s*%\s*off\s*/i, '')];
    for (let i = titleLine + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(?:Original|Regular|Reg\.?|Deal|Final|Sale|Product|Discount|After\s+the\s+discount)\s*Price\s*[:：]|^Price\s+before\s+discount\s*[:：]|^(?:Discount|Promo|Coupon)\s*(?:Code|Ratio)\s*[:：]|^Code\s*[:：]|^Code\s+(?:Start|End|Expiration)\s+(?:Date|Time)\s*[:：]|^(?:Start|End)\s+(?:Date|Day|Time)\s*[:：]|^Link\s*[:：]|^URL\s*[:：]|^ASIN\s*[:：]|^ACC\s|^\$?\d+(?:\.\d{2})?\s*\(Reg\.|^\d{1,2}\s*%\s*off\s*=/i.test(line) || /^https?:/i.test(line)) break;
      titleLines.push(line);
    }
    title = titleLines.join(' ').trim() || null;
  }
  if (title) title = title
    .replace(/^#?\d+[.)]\s*/, '')
    .replace(/^\d+%\s*off\s*/i, '')
    .replace(/\s*[|:]\s*amazon\b.*/i, '')
    .trim();
  if (title) {
    title = cleanProductTitle(title).slice(0, 200);
  }

  const dealMatch = block.match(/(?:^|\n)\s*(?:(?:Deal|Final|Sale|Product|Discount|After\s+the\s+discount)\s*)Price\s*[:：\s]+\$?([\d.,]+)/im)
    || block.match(/\$?(\d{1,4}(?:\.\d{2})?)(?:\s*[-–]\s*\$?\d+(?:\.\d{2})?)?\s*\(Reg\.?\s*\$?/i);
  const dealPrice = dealMatch?.[1] ? `$${dealMatch[1].replace(/,/g, '')}` : null;

  const originalMatch = block.match(/(?:^|\n)\s*(?:Original\s*Price|Price\s+before\s+discount|Reg\.?\s*Price|Was|Regular\s*Price|List\s*Price)\s*[:：\s]+\$?([\d.,]+)/im)
    || block.match(/\(Reg\.\s*\$?([\d.,]+)/i);
  const originalPrice = originalMatch?.[1] ? `$${originalMatch[1].replace(/,/g, '')}` : null;

  const codeMatch = block.match(/(?:^|\n)\s*(?:(?:Promo|Coupon|Discount)\s+)?Code\s*[:：=\-]\s*\[?([A-Z0-9]{4,20})\]?\b/im)
    || block.match(/\b\d{1,2}\s*%\s*off\s+(?:with\s+)?code\s*[:：=\-]\s*\[?([A-Z0-9]{4,20})\]?\b/i)
    || block.match(/\b(?:with|use|apply|enter)\s+code\s*[:：=\-]?\s*\[?([A-Z0-9]{4,20})\]?\b/i);
  const invalidCodes = new Set(['RATIO', 'PRICE', 'DATE', 'END', 'START', 'DEAL', 'CODE', 'PROMO', 'AMAZON']);
  const codeCandidate = codeMatch?.[1]?.toUpperCase() || null;
  const discountCode = codeCandidate && !invalidCodes.has(codeCandidate) ? codeCandidate : null;

  const urls = extractAmazonUrls(block);
  // Prefer the direct product URL when a block includes both a /dp/ link and
  // a promo campaign link; it is the reliable source for its ASIN and image.
  const amazonUrl = urls.find(url => /\/(?:dp|gp\/product)\//i.test(url)) || urls[0] || null;
  const asin = amazonUrl?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]
    || block.match(/\bASIN\s*[:：]\s*([A-Z0-9]{10})\b/i)?.[1]
    || null;
  const expirationMatch = block.match(/(?:Code\s+)?(?:End\s*(?:Date|Day|Time)|Expir(?:es?|ation)\s*(?:Date)?)\s*[:：\s]+([^\n]+)/i);
  let expirationDate = null;
  if (expirationMatch?.[1]) {
    const date = new Date(expirationMatch[1].trim());
    if (!Number.isNaN(date.getTime())) expirationDate = date.toISOString();
  }

  return { title, dealPrice, originalPrice, discountCode, amazonUrl, asin, expirationDate, isProductBlock: !isHeaderOnly && titleLine >= 0 };
}

function parseDollar(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.]/g, ''));
  return isNaN(n) ? null : n;
}

function buildAffiliateUrl(asin, rawUrl) {
  if (asin) return `https://www.amazon.com/dp/${asin}?tag=${AFFILIATE_TAG}`;
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('tag', AFFILIATE_TAG);
    return u.toString();
  } catch {
    return rawUrl + (rawUrl.includes('?') ? '&' : '?') + `tag=${AFFILIATE_TAG}`;
  }
}

function buildAsinImageUrl(asin) {
  return asin
    ? `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.LZZZZZZZ.jpg`
    : null;
}

function canonicalAmazonUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const promoMatch = url.pathname.match(/\/promocode\/([^/?#]+)/i);
    if (promoMatch) return `promo:${promoMatch[1].toUpperCase()}`;

    const asinMatch = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (asinMatch) return `asin:${asinMatch[1].toUpperCase()}`;

    return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return String(rawUrl || '').split('?')[0].replace(/\/$/, '');
  }
}

function getDedupKeys({ asin, discountCode, amazonUrl, productUrl }) {
  const code = String(discountCode || '').trim().toUpperCase();
  const urlKey = canonicalAmazonUrl(amazonUrl || productUrl || '');
  const suffix = `|code:${code || '-'}`;
  const keys = new Set();

  // Keep the promo campaign ID and, once Amazon resolves it, its first ASIN.
  // Saved promo records use the resolved /dp/ URL, so retaining both keys lets
  // a later copy of the same email match the record already in the system.
  if (urlKey) keys.add(`${urlKey}${suffix}`);
  if (asin) keys.add(`asin:${String(asin).toUpperCase()}${suffix}`);
  return keys;
}

function hasAnyDedupKey(keys, existingKeys) {
  return [...keys].some(key => existingKeys.has(key));
}

function toAmazon400ImageUrl(imageUrl) {
  if (!/^https:\/\/m\.media-amazon\.com\/images\/I\//i.test(imageUrl || '')) return imageUrl;
  return imageUrl.replace(/(?:\._[^/]+)?\.jpg(?:\?[^#]*)?$/i, '._SR400,400_.jpg');
}

function decodeAmazonImageUrl(imageUrl) {
  return imageUrl
    ? imageUrl.replace(/\\u0026/gi, '&').replace(/\\\//g, '/')
    : null;
}

function findFirstAsin(source) {
  const text = String(source || '');
  const patterns = [
    /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#&"'\s]|$)/gi,
    /\\?\/(?:dp|gp\\?\/product)\\?\/([A-Z0-9]{10})(?:[/?#&"'\\s]|$)/gi,
    /data-asin\s*=\s*["']([A-Z0-9]{10})["']/gi,
    /["']asin["']\s*[:=]\s*["']([A-Z0-9]{10})["']/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) return match[1].toUpperCase();
  }

  return null;
}

async function resolvePromoAsin(url) {
  if (!/amazon\.com\/promocode\//i.test(url || '')) return null;

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(5000),
    });

    // A promo link can occasionally redirect directly to one product page.
    const redirectedAsin = findFirstAsin(r.url);
    if (redirectedAsin) return redirectedAsin;
    if (!r.ok) return null;

    // Promo pages can list several products. Use the first product ASIN Amazon
    // exposes, so this remains a promo-only fallback and never changes /dp/ URLs.
    return findFirstAsin(await r.text());
  } catch {
    return null;
  }
}

async function resolveAsin(url) {
  const direct = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
  if (direct) return direct;
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(4000) });
    const redirectedAsin = (r.url || url).match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
    if (redirectedAsin) return redirectedAsin;
  } catch { /* Try the promo-page-only fallback below. */ }

  return resolvePromoAsin(url);
}

function decodeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function attributeValue(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtmlAttribute(match[2]) : null;
}

function isPromoProductImage(url, imageTag) {
  if (!/^https:\/\/(?:m\.media-amazon\.com|images-na\.ssl-images-amazon\.com)\/images\//i.test(url || '')) return false;
  if (/(?:logo|icon|sprite|badge|banner|pixel|transparent|placeholder)/i.test(url)) return false;
  const width = Number(attributeValue(imageTag, 'width'));
  const height = Number(attributeValue(imageTag, 'height'));
  return !(width && height && width < 80 && height < 80);
}

function imageFromPromoCard(cardHtml) {
  const images = cardHtml.match(/<img\b[^>]*>/gi) || [];
  for (const imageTag of images) {
    const dynamic = attributeValue(imageTag, 'data-a-dynamic-image');
    if (dynamic) {
      try {
        const url = Object.keys(JSON.parse(dynamic))[0];
        if (isPromoProductImage(url, imageTag)) return url;
      } catch { /* Continue with the remaining image attributes. */ }
    }

    const dataSrc = attributeValue(imageTag, 'data-src');
    if (isPromoProductImage(dataSrc, imageTag)) return dataSrc;

    const srcset = attributeValue(imageTag, 'srcset');
    for (const source of (srcset || '').split(',')) {
      const url = source.trim().split(/\s+/)[0];
      if (isPromoProductImage(url, imageTag)) return url;
    }

    const src = attributeValue(imageTag, 'src');
    if (isPromoProductImage(src, imageTag)) return src;
  }
  return null;
}

function normalizedTitleTokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function titleMatchScore(targetTitle, cardTitle) {
  const target = normalizedTitleTokens(targetTitle);
  const candidate = normalizedTitleTokens(cardTitle);
  if (!target.size || !candidate.size) return 0;
  let matches = 0;
  for (const token of target) if (candidate.has(token)) matches++;
  return matches / target.size;
}

// Promo landing pages are not product pages. This reads only their product-card
// anchors and images; ordinary /dp/ image handling remains unchanged.
async function fetchPromoProductImage(promoUrl, parsedTitle) {
  try {
    const response = await fetch(promoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok || /\/errors\/404\.html/i.test(response.url)) return null;

    const html = await response.text();
    const cards = [];
    const anchorPattern = /<a\b([^>]*\bclass=["'][^"']*\bimageLink\b[^"']*["'][^>]*)>([\s\S]{0,2500}?)<\/a>/gi;
    let match;
    while ((match = anchorPattern.exec(html)) !== null) {
      const href = attributeValue(match[1], 'href');
      const asin = href?.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
      const image = imageFromPromoCard(match[2]);
      if (!asin || !image) continue;

      const afterCard = html.slice(match.index + match[0].length, match.index + match[0].length + 8000);
      const title = decodeHtmlAttribute(afterCard.match(/class=["'][^"']*\btitleLink\b[^"']*["'][^>]*>[\s\S]{0,800}?class=["'][^"']*\ba-truncate-full\b[^"']*["'][^>]*>([^<]+)/i)?.[1] || '');
      cards.push({ asin, image, title });
    }
    if (!cards.length) return null;

    const best = cards.reduce((current, card) =>
      titleMatchScore(parsedTitle, card.title) > titleMatchScore(parsedTitle, current.title) ? card : current
    );
    console.log(`[Promo image] ${cards.length} cards; matched "${best.title || '[first card]'}" → ${best.asin}`);
    return best;
  } catch (error) {
    console.log(`[Promo image] lookup failed: ${error.message}`);
    return null;
  }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PER-PRODUCT CONTEXT WINDOW (+-600 chars around each URL)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function getProductContext(rawHtml, plainText, url, asin) {
  const terms = [url, ...(asin ? [asin] : [])];
  const urlPat = /https?:\/\/(?:www\.)?(?:amazon\.com|amzn\.to|amzn\.com|a\.co)[^\s"'<>)]+/gi;

  for (const source of [plainText || '', rawHtml || '']) {
    if (!source) continue;
    const urlBoundaries = [];
    let match;
    while ((match = urlPat.exec(source)) !== null) urlBoundaries.push({ pos: match.index, end: match.index + match[0].length });
    urlPat.lastIndex = 0;

    for (const term of terms) {
      const idx = source.indexOf(term);
      if (idx >= 0) {
        const prev = urlBoundaries.filter(item => item.end <= idx).slice(-1)[0];
        const next = urlBoundaries.find(item => item.pos > idx);
        const start = prev ? prev.end : Math.max(0, idx - 3000);
        const end = next ? next.pos : Math.min(source.length, idx + term.length + 3000);
        const context = source.slice(start, end);
        return source === rawHtml ? htmlToTextWithLines(context) : context;
      }
    }
  }

  // Fallback: stripped HTML or plain text
  const stripped = htmlToTextWithLines(rawHtml);
  const W = 600;
  for (const src of [stripped, plainText || '']) {
    for (const term of terms) {
      const idx = src.indexOf(term);
      if (idx >= 0) return src.slice(Math.max(0, idx - W), idx + term.length + W);
    }
  }
  return '';
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// FIELD EXTRACTORS
// Each receives only THIS product's context window.
// If a field is not found, return null.
// Never read from the full email or another product's context.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function extractTitle(context, url) {
  const urlPos = url ? context.indexOf(url) : -1;
  const region = urlPos > 0 ? context.slice(0, urlPos) : context;
  const lines = region
    .split(/[\n\r]+/)
    .map(l => l.replace(/[*_#>]+/g, ' ').trim())
    .filter(l =>
      l.length >= 15 && l.length <= 200 &&
      /[a-zA-Z]{4}/.test(l) &&
      !/^\$/.test(l) &&
      !/^https?:/.test(l) &&
      !/^\d+(\.\d+)?$/.test(l) &&
      !/^\d[\d.\-]*\s*\(Reg/i.test(l) &&
      !/^[\d.\-\s]+$/.test(l.replace(/Reg\.\d[\d.\-]*/gi,'').replace(/[()]/g,'').trim())
    );
  const title = cleanProductTitle(lines[lines.length - 1] || '');
  return title || null;
}

function extractPrice(context) {
  const patterns = [
    /\b(\d{1,4}\.\d{2})(?:\s*[-]\s*\d+\.\d{2})?\s*\(Reg\./i,
    /(?:deal|sale|now|only|get\s+it\s+for)[:\s]+\$\s*([\d,]+\.?\d*)/i,
    /price[:\s]+\$\s*([\d,]+\.?\d*)/i,
    /(?:^|\s)\$\s*([\d,]+\.\d{2})(?!\s*(?:off|discount|save|was|original|reg|before))/m,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1]) {
      const val = parseDollar(m[1]);
      if (val && val > 0.5 && val < 10000) return `$${val.toFixed(2)}`;
    }
  }
  return null;
}

function extractOriginalPrice(context) {
  const patterns = [
    /\(Reg\.\s*(\d+\.?\d*)(?:\s*[-]\s*\d+\.?\d*)?\)/i,
    /(?:was|original|reg(?:ular)?|list|retail|msrp|normally|before)[:\s]*\$\s*([\d,]+\.?\d*)/i,
    /\$\s*([\d,]+\.\d{2})\s*(?:->|before)/i,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1]) {
      const val = parseDollar(m[1]);
      if (val && val > 0.5 && val < 10000) return `$${val.toFixed(2)}`;
    }
  }
  return null;
}

function extractPromoCode(context) {
  // STRICT: only this product's context window â never the full email.
  const STOP = new Set([
    'GET', 'USE', 'THE', 'FOR', 'AND', 'WITH', 'OFF', 'CODE', 'PROMO',
    'DISCOUNT', 'COUPON', 'DEAL', 'SALE', 'SAVE', 'CLIP', 'CHECK', 'VIEW',
    'MORE', 'SHOP', 'FREE', 'FAST', 'BEST', 'CLICK', 'HERE', 'LINK',
    'ITEM', 'OFFER', 'PRICE', 'AMAZON', 'CHECKOUT',
  ]);
  const patterns = [
    /(?:code|coupon|promo|discount|voucher)[:\s=]+\[?([A-Z0-9]{4,20})\]?/i,
    /apply\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?\s+at/i,
    /use\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']?(?:\s|$)/i,
    /enter\s+(?:code\s+)?["']?([A-Z0-9]{5,20})["']/i,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1] && !STOP.has(m[1].toUpperCase())) return m[1].toUpperCase();
  }
  return null;
}

function extractExpirationDate(context) {
  const patterns = [
    /(?:expires?|valid\s+(?:through|until|thru)|ends?|offer\s+ends?)\s*:?\s*([A-Za-z]+\s+\d{1,2}(?:,?\s*\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i,
    /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?)\b/i,
    /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m?.[1]) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime()) && d.getFullYear() >= new Date().getFullYear()) return d.toISOString();
    }
  }
  return null;
}

function extractImageForProduct(rawHtml, cdnImages, asin, url) {
  if (!cdnImages.length) return null;
  // 1. ASIN match (most reliable)
  if (asin) {
    const match = cdnImages.find(img => img.includes(asin));
    if (match) return match;
  }
  // 2. Proximity: image closest to this URL in raw HTML (within 3000 chars)
  const urlPos = rawHtml.indexOf(url);
  if (urlPos >= 0) {
    let best = null, bestDist = Infinity;
    for (const img of cdnImages) {
      const pos = rawHtml.indexOf(img);
      if (pos >= 0) {
        const dist = Math.abs(pos - urlPos);
        if (dist < bestDist && dist < 3000) { bestDist = dist; best = img; }
      }
    }
    if (best) return best;
  }
  // 3. No match â return null, never borrow from another product
  return null;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// AMAZON META FETCH (fallback for missing title / image / price)
// Only called after extraction if those fields are still null.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function fetchAmazonMeta(url) {
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return {};
    const html = await r.text();
    const title = html.match(/<span[^>]*id="productTitle"[^>]*>\s*([^<]+?)\s*<\/span>/i)?.[1]?.trim() || null;
    const imageCandidate =
      html.match(/"hiRes"\s*:\s*"(https:[^"]+)"/)?.[1] ||
      html.match(/"large"\s*:\s*"(https:[^"]+)"/)?.[1] ||
      html.match(/id="landingImage"[^>]*data-old-hires="([^"]+)"/i)?.[1] ||
      html.match(/https?:\\?\/\\?\/m\.media-amazon\.com\\?\/images\\?\/I\\?\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/i)?.[0] ||
      null;
    const image = decodeAmazonImageUrl(imageCandidate);
    const pw = html.match(/class="a-price-whole"[^>]*>(\d+)<\/span>/)?.[1];
    const pf = html.match(/class="a-price-fraction"[^>]*>(\d+)<\/span>/)?.[1];
    const price = pw ? parseDollar(`${pw}.${pf || '00'}`) : null;
    const origM = html.match(/class="a-text-price"[^>]*><span[^>]*>\$\s*([\d,.]+)<\/span>/);
    const originalPrice = origM ? parseDollar(origM[1]) : null;
    return {
      title,
      image,
      price: price ? `$${price.toFixed(2)}` : null,
      originalPrice: originalPrice ? `$${originalPrice.toFixed(2)}` : null,
    };
  } catch { return {}; }
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PHASE 1 â Extract all product drafts (no DB writes)
// Each draft contains only what was found in that product's context.
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function extractAllProducts(rawHtml, plainText, emailText) {
  const cdnImages = extractCdnImages(rawHtml);
  const combined = rawHtml + '\n' + (plainText || '') + '\n' + (emailText || '');
  const structuredText = plainText || emailText || htmlToTextWithLines(rawHtml);
  const blocks = splitProductBlocks(structuredText);

  if (blocks.length > 0) {
    const drafts = [];
    const seenKeys = new Set();
    for (const block of blocks) {
      const fields = extractStructuredProductData(block);
      if (!fields.isProductBlock || !fields.amazonUrl) continue;
      const asin = fields.asin || await resolveAsin(fields.amazonUrl);
      const dedupKeys = getDedupKeys({ ...fields, asin });
      if (hasAnyDedupKey(dedupKeys, seenKeys)) continue;
      for (const key of dedupKeys) seenKeys.add(key);
      drafts.push({
        amazonUrl:      fields.amazonUrl,
        asin:           asin || null,
        productName:    fields.title || null,
        dealPrice:      fields.dealPrice || null,
        originalPrice:  fields.originalPrice || null,
        discountCode:   fields.discountCode || null,
        expirationDate: fields.expirationDate || null,
        imageUrl:       extractImageForProduct(rawHtml, cdnImages, asin, fields.amazonUrl) || null,
      });
    }
    if (drafts.length > 0) {
      console.log(`[Phase 1] Structured blocks: ${blocks.length}, products: ${drafts.length}, CDN images: ${cdnImages.length}`);
      return { drafts, urlsFound: drafts.length };
    }
  }

  const allUrls = extractAmazonUrls(combined);
  const urlsToProcess = allUrls;
  console.log(`[Phase 1] Fallback URLs found: ${allUrls.length}, processing: ${urlsToProcess.length}, CDN images: ${cdnImages.length}`);

  const drafts = [];
  const seenKeys = new Set();
  for (let i = 0; i < urlsToProcess.length; i++) {
    const url = urlsToProcess[i];
    const asin = await resolveAsin(url);
    const dedupKeys = getDedupKeys({ asin, amazonUrl: url });
    if (hasAnyDedupKey(dedupKeys, seenKeys)) continue;
    for (const key of dedupKeys) seenKeys.add(key);

    const draft = {
      amazonUrl:      url,
      asin:           asin || null,
      productName:    null,
      dealPrice:      null,
      originalPrice:  null,
      discountCode:   null,
      expirationDate: null,
      imageUrl:       extractImageForProduct(rawHtml, cdnImages, asin, url) || null,
    };

    console.log(`[Phase 1] Product ${i + 1}/${urlsToProcess.length}:`, JSON.stringify({
      url:            url.slice(0, 60),
      asin:           draft.asin,
      productName:    draft.productName,
      dealPrice:      draft.dealPrice,
      originalPrice:  draft.originalPrice,
      discountCode:   draft.discountCode,
      expirationDate: draft.expirationDate,
      imageUrl:       draft.imageUrl ? '[found]' : null,
      contextLen:     0,
    }));

    drafts.push(draft);
  }

  return { drafts, urlsFound: allUrls.length };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PHASE 2 â Validate each draft independently
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function validateDraft(draft, i) {
  const issues = [];
  if (!draft.amazonUrl) issues.push('no Amazon URL');
  if (!draft.asin && !/\/dp\/|\/gp\/product\/|\/promocode\//i.test(draft.amazonUrl || '')) {
  issues.push('could not resolve ASIN and URL is not a direct product link');
}
  if (issues.length === 0) {
    if (!draft.productName)   console.log(`[Phase 2] Product ${i + 1}: no title in context â will try Amazon page`);
    if (!draft.dealPrice)     console.log(`[Phase 2] Product ${i + 1}: no price in context â will try Amazon page`);
    if (!draft.imageUrl)      console.log(`[Phase 2] Product ${i + 1}: no image in email â will try Amazon page`);
  }
  return { valid: issues.length === 0, issues };
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// PHASE 3 â Save each validated draft (with Amazon enrichment)
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

async function saveDraft(draft, store, indexArr, ids, deals, existingKeys) {
  const dedupKeys = getDedupKeys(draft);
  if (hasAnyDedupKey(dedupKeys, existingKeys)) {
    console.log(`[Phase 3] Duplicate skipped: ${[...dedupKeys].join(', ')}`);
    return null;
  }
  const isPromoUrl = /amazon\.com\/promocode\//i.test(draft.amazonUrl || '');
  let { productName: title, dealPrice, originalPrice, imageUrl } = draft;

  if (isPromoUrl) {
    const promoProduct = await fetchPromoProductImage(draft.amazonUrl, title);
    if (promoProduct) {
      imageUrl = promoProduct.image;
      draft.asin = draft.asin || promoProduct.asin;
    }
  }

  const affiliateUrl = buildAffiliateUrl(draft.asin, draft.amazonUrl);

  if (!title || !imageUrl || !dealPrice) {
    const meta = await fetchAmazonMeta(affiliateUrl);
    title         = title         || meta.title         || null;
    imageUrl      = imageUrl      || meta.image         || null;
    dealPrice     = dealPrice     || meta.price         || null;
    originalPrice = originalPrice || meta.originalPrice || null;
  }
  imageUrl = imageUrl || buildAsinImageUrl(draft.asin);
  imageUrl = isPromoUrl ? toAmazon400ImageUrl(imageUrl) : imageUrl;

  const priceNum        = parseDollar(dealPrice);
  const origNum         = parseDollar(originalPrice);
  const discountPercent = (priceNum && origNum && origNum > priceNum)
    ? Math.round((1 - priceNum / origNum) * 100) : null;

  const expiresOn = draft.expirationDate || (() => {
    const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString();
  })();

  const id = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    productTitle:   title || '',
    productUrl:     affiliateUrl,
    asin:           draft.asin || null,
    price:          dealPrice || '',
    originalPrice:  originalPrice || null,
    discountPercent,
    discountCode:   draft.discountCode || null,
    image:          imageUrl || null,
    expiresOn,
    status:         'pending',
    source:         'email',
    createdAt:      new Date().toISOString(),
    submittedAt:    new Date().toISOString(),
  };

  await store.set(id, JSON.stringify(record));
  indexArr.unshift(id);
  for (const key of dedupKeys) existingKeys.add(key);
  ids.push(id);
  deals.push({ id, title: record.productTitle, price: record.price, url: affiliateUrl, imageUrl: record.image, discountCode: record.discountCode });

  console.log(`[Phase 3] Saved ${id}: "${record.productTitle}" ${record.price} code=${record.discountCode}`);
  return record;
}

async function loadExistingDedupKeys(store, indexArr) {
  const keys = new Set();
  const batchSize = 20;

  for (let i = 0; i < indexArr.length; i += batchSize) {
    const batch = indexArr.slice(i, i + batchSize);
    const records = await Promise.all(batch.map(async (id) => {
      try { return await store.get(id, { type: 'json' }); }
      catch { return null; }
    }));
    for (const record of records) {
      if (record?.productUrl || record?.asin) {
        for (const key of getDedupKeys(record)) keys.add(key);
      }
    }
  }

  return keys;
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// MAIN HANDLER
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

export default async (req) => {
  try {
    let rawHtml = '', plainText = '', emailText = '';
    const ct = req.headers.get('content-type') || '';

    if (ct.includes('application/json')) {
      const b = await req.json();
      rawHtml = b.htmlBody || b.html || ''; plainText = b.textBody || b.text || ''; emailText = b.emailText || b.email || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f = await req.formData();
      rawHtml = f.get('htmlBody') || f.get('html') || ''; plainText = f.get('textBody') || f.get('text') || ''; emailText = f.get('emailText') || f.get('email') || '';
    } else {
      const t = await req.text(); rawHtml = t; emailText = t;
    }

    if (!rawHtml && !plainText && !emailText) {
      return new Response(JSON.stringify({ success: false, error: 'No email content received' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    // ââ PHASE 1: Extract âââââââââââââââââââââââââââââââââââ
    const { drafts, urlsFound } = await extractAllProducts(rawHtml, plainText, emailText);
    console.log(`[Phase 1] Complete: ${drafts.length} drafts from ${urlsFound} URLs`);

    // ââ PHASE 2: Validate ââââââââââââââââââââââââââââââââââ
    const validDrafts = [];
    for (let i = 0; i < drafts.length; i++) {
      const { valid, issues } = validateDraft(drafts[i], i);
      if (valid) validDrafts.push(drafts[i]);
      else console.warn(`[Phase 2] Product ${i + 1} rejected:`, issues.join('; '));
    }
    console.log(`[Phase 2] Complete: ${validDrafts.length}/${drafts.length} valid`);

    if (validDrafts.length === 0) {
      return new Response(JSON.stringify({
        success: false, error: 'No valid Amazon products found in email',
        amazonUrlsFound: urlsFound, draftsExtracted: drafts.length,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ââ PHASE 3: Save ââââââââââââââââââââââââââââââââââââââ
    const store = getStore('submissions');
    let indexArr = [];
    try {
      const existing = await store.get('index', { type: 'json' });
      if (Array.isArray(existing)) indexArr = existing;
    } catch { /* no index yet */ }
    const existingKeys = await loadExistingDedupKeys(store, indexArr);
    console.log(`[Phase 3] Existing deal keys: ${existingKeys.size}`);

    const ids = [], deals = [], savedRecords = [];
    for (const draft of validDrafts) {
      try {
        const record = await saveDraft(draft, store, indexArr, ids, deals, existingKeys);
        if (record) savedRecords.push(record);
      } catch (err) {
        console.error(`[Phase 3] Failed to save ${draft.amazonUrl}:`, err.message);
      }
    }

    if (savedRecords.length > 0) await store.set('index', JSON.stringify(indexArr));
    console.log(`[Phase 3] Complete: ${savedRecords.length} records saved`);

    const first = savedRecords[0];
    const telegramMessage = first
      ? `*${first.productTitle || 'Deal'}*\n${first.price || ''}${first.discountCode ? `\nCode: ${first.discountCode}` : ''}\n${first.productUrl}`
      : null;
    const facebookMessage = first
      ? `${first.productTitle || 'Deal'}${first.price ? ` - ${first.price}` : ''}${first.discountCode ? ` | Code: ${first.discountCode}` : ''}\n${first.productUrl}`
      : null;

    return new Response(JSON.stringify({
      success: true, count: savedRecords.length, ids, deals, amazonUrlsFound: urlsFound,
      telegramMessage, facebookMessage,
      title: first?.productTitle || null, price: first?.price || null,
      originalPrice: first?.originalPrice || null, url: first?.productUrl || null, imageUrl: first?.image || null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('[submit-email-deal] Fatal:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/submit-email-deal' };
