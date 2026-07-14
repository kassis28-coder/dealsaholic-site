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

// ── fetch Amazon page metadata (with promo-page fallback for image) ───────────
const AMAZON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml',
};

function extractOgImage(html) {
  return html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
    || null;
}

async function fetchProductPageImage(asin) {
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, { headers: AMAZON_HEADERS, redirect: 'follow' });
    if (!res.ok) return null;
    return extractOgImage(await res.text());
  } catch { return null; }
}

async function fetchAmazonMeta(amazonUrl) {
  const { asin: asinFromRedirect, finalUrl: redirectUrl } = await followRedirectForAsin(amazonUrl);
  try {
    const res = await fetch(amazonUrl, { headers: AMAZON_HEADERS, redirect: 'follow' });
    if (!res.ok) return asinFromRedirect ? { title: null, price: null, image: null, asin: asinFromRedirect, finalUrl: redirectUrl } : null;

    const finalUrl = res.url;
    let asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || asinFromRedirect || null;
    const html = await res.text();

    let title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    let image = extractOgImage(html);

    // Promo pages don't redirect to /dp/ — scan HTML body for product ASIN link
    if (!asin || !image) {
      const bodyAsin = html.match(/\/dp\/([A-Z0-9]{10})[/"'?\s]/i)?.[1];
      if (bodyAsin && !asin) asin = bodyAsin;
      if (asin && !image) image = await fetchProductPageImage(asin);
    }

    const priceMatch = html.match(/["']priceAmount["']\s*:\s*["']?([\d.]+)["']?/)
      || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;
    return {
      title: title?.replace(/\s*[|:]\s*amazon\b.*/i, '').replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '').trim().substring(0, 150) || null,
      image, price, asin, finalUrl,
    };
  } catch (e) {
    return asinFromRedirect ? { title: null, price: null, image: null, asin: asinFromRedirect, finalUrl: redirectUrl } : null;
  }
}

// ── Unchanged: extract Amazon URLs from text ─────────────────────────────────
function extractAmazonUrls(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
  ];
  const urls = [];
  for (const pattern of patterns) {
    [...text.matchAll(new RegExp(pattern.source, 'gi'))].forEach(m => urls.push(m[0]));
  }
  return urls;
}

// ── Unchanged: strip HTML tags ────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

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

function splitProductBlocks(text) {
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
  return [text];
}

function extractProductData(block) {
  const titleMatch = block.match(/Product\s*[Nn]ame\s*[:\s]+([^\n]+)/i);
  let title = titleMatch?.[1]?.trim().substring(0, 150) || null;
  if (title) title = title
    .replace(/amazon\.com\s*/gi, '').replace(/\s*[|:]\s*amazon\b.*/i, '')
    .replace(/^\d+%\s*off\s+/i, '')
    .replace(/^hotsales\s+/i, '')
    .replace(/\s*[—–]\s*only\s+\$[\d.]+[^!]*!?\s*$/i, '')
    .trim();

  const priceMatch = block.match(/(?:Deal\s*Price|Final\s*Price|Sale\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;

  const origMatch = block.match(/(?:Original\s*Price|Reg\.?\s*Price|Was|Regular\s*Price|List\s*Price)\s*[:\s]+\$?([\d.,]+)/i);
  const originalPrice = origMatch ? '$' + origMatch[1].replace(/,/g, '') : null;

  const discountMatch = block.match(/(\d+)\s*%\s*(?:off|discount)/i);
  const discount = discountMatch?.[1] || null;

  const codeMatch = block.match(/(?:^|\n)\s*(?:code|coupon|promo)\s*[:\s]+([A-Z0-9]{4,20})/im)
    || block.match(/\bwith\s+code\s*[:\s]+([A-Z0-9]{4,20})/i)
    || block.match(/\bcode\s*[:\s]+([A-Z0-9]{4,20})\b/i);
  const discountCode = codeMatch?.[1]?.trim() || null;

  const dpMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s"'<>]*/i);
  const promoMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:promocode|promotion|gp\/promocode)\/[A-Za-z0-9]+[^\s"'<>]*/i);
  const shortMatch = block.match(/https?:\/\/(?:amzn\.to|a\.co)\/[A-Za-z0-9\/]+/i);

  const asin = dpMatch?.[1] || null;
  const rawUrl = dpMatch?.[0] || promoMatch?.[0] || shortMatch?.[0] || null;

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
  const cleanedText = cleanEmailContent(stripHtml(rawContent));

  const store = getStore('submissions');
  const savedIds = [];
  const deals = [];

  const blocks = splitProductBlocks(cleanedText);

  for (const block of blocks) {
    const { title: blockTitle, price, originalPrice, discount, discountCode, rawUrl, asin: blockAsin, expiresOn } = extractProductData(block);

    if (!rawUrl) continue;

    let asin = blockAsin;
    let meta = null;

    if (!asin) {
      const redirectResult = await followRedirectForAsin(rawUrl);
      asin = redirectResult.asin || null;
    }

    meta = await fetchAmazonMeta(rawUrl);
    if (meta?.asin && !asin) asin = meta.asin;

    const affiliateUrl = asin
      ? 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20'
      : rawUrl.includes('tag=')
      ? rawUrl
      : rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'tag=kethya08-20';

    const imageUrl = meta?.image || null;

    const finalTitle = blockTitle || meta?.title || 'Amazon Deal';
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
