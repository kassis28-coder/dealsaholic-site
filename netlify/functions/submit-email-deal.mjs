import { getStore } from "@netlify/blobs";

// ── Unchanged: follow redirect to resolve ASIN ───────────────────────────────
async function followRedirectForAsin(amazonUrl) {
  try {
    const res = await fetch(amazonUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    });
    const finalUrl = res.url || amazonUrl;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    return { asin, finalUrl };
  } catch (e) {
    return { asin: null, finalUrl: amazonUrl };
  }
}

// ── Unchanged: fetch Amazon page metadata ────────────────────────────────────
async function fetchAmazonMeta(amazonUrl) {
  const { asin: asinFromRedirect, finalUrl: redirectUrl } = await followRedirectForAsin(amazonUrl);
  try {
    const res = await fetch(amazonUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
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
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
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

// ── Unchanged: strip HTML tags ────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')        // collapse horizontal whitespace only
    .replace(/\n[ \t]+/g, '\n')     // trim leading spaces on each line
    .trim();
}

// ── FIX 2: Remove automated error message appended to real email content ─────
function cleanEmailContent(text) {
  const markers = [
    /&emailText=/i,
    /This is an automated message/i,
    /Your deals could NOT be processed/i,
    /Reason\s*:\s*Duplicate/i,
  ];
  let cleaned = text;
  for (const marker of markers) {
    const idx = cleaned.search(marker);
    if (idx !== -1) cleaned = cleaned.slice(0, idx);
  }
  return cleaned.trim();
}

// ── FIX 3: Split email into individual numbered product blocks ────────────────
function splitProductBlocks(text) {
  // Try two formats:
  // A: "1 Product name:" on same line (e.g. "1 Product name: Shirt")
  // B: "1." or "1)" on its own line (e.g. "1.\nProduct name: Shirt")
  const patterns = [
    /(?:^|\n)\s*\d+\s+Product\s*[Nn]ame/g,
    /(?:^|\n)\s*\d+[.)]\s*(?:\n|$)/g,
  ];
  for (const regex of patterns) {
    const matches = [...text.matchAll(regex)];
    if (matches.length > 1) {
      const blocks = [];
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index;
        const end = matches[i + 1]?.index ?? text.length;
        blocks.push(text.slice(start, end).trim());
      }
      return blocks.filter(b => b.length > 10);
    }
  }
  return [text]; // single product or unnumbered
}

// ── FIX 4 & 5 & 6: Extract all fields from a single product block ─────────────
function extractProductData(block) {
  // FIX 5: Title from "Product name:" label only
  const titleMatch = block.match(/Product\s*[Nn]ame\s*[:\s]+([^\n]+)/i);
  let title = titleMatch?.[1]?.trim().substring(0, 150) || null;
  if (title) title = title.replace(/amazon\.com\s*/gi, '').replace(/\s*[|:]\s*amazon\b.*/i, '').trim();

  // FIX 4: Only match explicit sale price labels — NOT "Reg. Price" or "Original Price"
  const priceMatch = block.match(/(?:Deal\s*Price|Final\s*Price|Sale\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;

  // Original price — also handles "Reg. Price"
  const origMatch = block.match(/(?:Original\s*Price|Reg\.?\s*Price|Was|Regular\s*Price|List\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const originalPrice = origMatch ? '$' + origMatch[1].replace(/,/g, '') : null;

  // Discount % from this block only
  const discountMatch = block.match(/(\d+)\s*%\s*(?:off|discount)/i);
  const discount = discountMatch?.[1] || null;

  // FIX 4: Discount code — line-start first, then "with code:XXX" mid-line
  const codeMatch = block.match(/(?:^|\n)\s*(?:code|coupon|promo)\s*[:\s]+([A-Z0-9]{4,20})/im)
    || block.match(/\bwith\s+code\s*[:\s]+([A-Z0-9]{4,20})/i)
    || block.match(/\bcode\s*[:\s]+([A-Z0-9]{4,20})\b/i);
  const discountCode = codeMatch?.[1]?.trim() || null;

  // FIX 6: Amazon URL — prefer /dp/ link; fall back to promo or short links
  const dpMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>]*/i);
  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:promocode|promotion|gp\/promocode)\/[A-Za-z0-9]+[^\s"'<>]*/i);
  const shortMatch = block.match(/https?:\/\/(?:amzn\.to|a\.co)\/[A-Za-z0-9\/]+/i);

  const asin = dpMatch?.[1] || null;
  const rawUrl = dpMatch?.[0] || promoMatch?.[0] || shortMatch?.[0] || null;

  // Expiration date from "End Date:", "Expires:", etc.
  const expMatch = block.match(/(?:End\s*Date|Expir(?:es?|ation)\s*(?:Date)?)\s*[:\s]+([^\n]+)/i);
  let expiresOn = null;
  if (expMatch?.[1]) {
    try {
      const d = new Date(expMatch[1].trim());
      if (!isNaN(d.getTime())) expiresOn = d.toISOString();
    } catch {}
  }

  return { title, price, originalPrice, discount, discountCode, rawUrl, asin, expiresOn };
}

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

  const rawContent = (emailBody || title).trim();

  // FIX 2: Strip automated error message text before any parsing
  const cleanedText = cleanEmailContent(stripHtml(rawContent));

  const store = getStore('submissions');
  const savedIds = [];
  const deals = [];

  // FIX 3: Split into per-product blocks (handles single and multi-product emails)
  const blocks = splitProductBlocks(cleanedText);

  for (const block of blocks) {
    const { title: blockTitle, price, originalPrice, discount, discountCode, rawUrl, asin: blockAsin, expiresOn } = extractProductData(block);

    // Must have a URL to be a valid deal
    if (!rawUrl) continue;

    let asin = blockAsin;
    let meta = null;

    // FIX 6: If URL is a promo/short link (no ASIN), try to resolve ASIN via redirect
    if (!asin) {
      const redirectResult = await followRedirectForAsin(rawUrl);
      asin = redirectResult.asin || null;
    }

    // Fetch Amazon metadata for title/image enrichment
    meta = await fetchAmazonMeta(rawUrl);
    if (meta?.asin && !asin) asin = meta.asin;

    // Affiliate URL: ASIN-based /dp/ link preferred
    const affiliateUrl = asin
      ? 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20'
      : rawUrl.includes('tag=')
      ? rawUrl
      : rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'tag=kethya08-20';

    // Image: prefer og:image from Amazon page; ASIN P/ URL is a 1x1 fallback only
    const imageUrl = meta?.image || (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);

    // Title priority: block "Product name:" label → Amazon meta → fallback
    const finalTitle = blockTitle || meta?.title || 'Amazon Deal';

    // Price priority: block price → Amazon meta price
    const finalPrice = price || meta?.price || null;

    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);

    const submission = {
      id,
      title: finalTitle,
      price: finalPrice,
      originalPrice: originalPrice || null,
      discount: discount || null,
      url: affiliateUrl,
      imageUrl,
      discountCode: discountCode || null,
      source: 'email',
      status: 'pending',
      sponsored: false,
      facebookPosted: false,
      telegramPosted: false,
      createdAt: new Date().toISOString(),
      expiresOn: expiresOn || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.setJSON(id, submission);
    savedIds.push(id);
    deals.push({ id, title: finalTitle, price: finalPrice, url: affiliateUrl, imageUrl });

    let index = [];
    try { index = await store.get('index', { type: 'json' }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON('index', index);
    await new Promise(r => setTimeout(r, 10));
  }

  return new Response(JSON.stringify({
    success: true,
    count: deals.length,
    ids: savedIds,
    deals,
    title: deals[0]?.title || null,
    price: deals[0]?.price || null,
    url: deals[0]?.url || null,
    imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/submit-email-deal' };
