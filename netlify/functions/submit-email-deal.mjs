import { getStore } from "@netlify/blobs";

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

// Extract promo/coupon codes from Amazon product page HTML
function extractPromoCodeFromHtml(html) {
  if (!html) return null;

  // Pattern 1: JSON data in page scripts â "promoCode":"XXXXX" / "code":"XXXXX"
  // Amazon embeds deal/promo data as JSON in <script> blocks
  const jsonCodePatterns = [
    /"(?:promoCode|promotionCode|couponCode|discountCode)"\s*:\s*"([A-Z0-9]{4,20})"/i,
    /"code"\s*:\s*"([A-Z0-9]{6,20})"/,          // generic "code" key in promo JSON blocks
  ];
  for (const pat of jsonCodePatterns) {
    const m = html.match(pat);
    if (m) return m[1];
  }

  // Pattern 2: Visible text on page â "Use code XXXX", "Apply code XXXX at checkout"
  const textPatterns = [
    /(?:use|apply|enter|with)\s+(?:promo(?:tional)?\s+)?code\s+([A-Z0-9]{5,20})/i,
    /promo(?:tion)?\s+code[:\s]+([A-Z0-9]{5,20})/i,
    /coupon\s+code[:\s]+([A-Z0-9]{5,20})/i,
    /discount\s+code[:\s]+([A-Z0-9]{5,20})/i,
  ];
  for (const pat of textPatterns) {
    const m = html.match(pat);
    // Exclude common false positives (generic Amazon IDs, full ASINs in wrong context)
    if (m && m[1].length >= 5 && m[1].length <= 20) return m[1];
  }

  return null;
}

// Extract promo codes from email plain text â casts a wider net than the Amazon page
function extractPromoCodeFromText(text) {
  if (!text) return null;
  const patterns = [
    // "use code XXXXX" / "apply code XXXXX" / "enter code XXXXX"
    /(?:use|apply|enter|add|enter|with)\s+(?:promo(?:tional)?\s+)?code[:\s]+([A-Z0-9]{4,20})/i,
    // "promo code: XXXXX" / "coupon code XXXXX" / "discount code: XXXXX"
    /(?:promo(?:tional)?|coupon|discount)\s+code[:\s]+([A-Z0-9]{4,20})/i,
    // "code: XXXXX" / "code XXXXX" (shorter, higher risk of false positive â runs last)
    /\bcode[:\s]+([A-Z0-9]{6,20})\b/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

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
      return {
        title: null, price: null, promoCode: null,
        image: `https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg`,
        asin: asinFromRedirect, finalUrl: redirectUrl,
      };
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
    const promoCode = extractPromoCodeFromHtml(html);

    return {
      title: title?.replace(/\s*[|:]\s*amazon\b.*/i, '').replace(/\s{1,2}-\s{1,2}amazon\b.*/i, '').trim().substring(0, 150) || null,
      image, price, asin, finalUrl, promoCode,
    };
  } catch (e) {
    if (!asinFromRedirect) return null;
    return {
      title: null, price: null, promoCode: null,
      image: `https://m.media-amazon.com/images/P/${asinFromRedirect}.01._SCLZZZZZZZ_.jpg`,
      asin: asinFromRedirect, finalUrl: redirectUrl,
    };
  }
}

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

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractJson(text) {
  if (!text) return text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return text.slice(start, end + 1);
  return text;
}

function buildTelegramMessage(deals) {
  if (deals.length === 0) return null;

  const firstImage = deals[0].imageUrl;
  const imgLink = firstImage ? `<a href="${firstImage}">â</a>` : '';

  if (deals.length === 1) {
    const d = deals[0];
    const codeLine = d.promoCode ? `\nð·ï¸ <b>Code: ${d.promoCode}</b>` : '';
    return `${imgLink}ð¥ <b>New Deal Alert!</b>\n\nðï¸ <b>${d.title || 'Amazon Deal'}</b>\n\nð° <b>${d.price || 'Check link'}</b>${codeLine}\n\nð <a href="${d.url}">ð Grab this deal!</a>`;
  }

  const lines = deals.map((d, i) => {
    const codeLine = d.promoCode ? `\n   ð·ï¸ <b>Code: ${d.promoCode}</b>` : '';
    return `${i + 1}. ðï¸ <b>${d.title || 'Amazon Deal'}</b>\n   ð° <b>${d.price || 'Check link'}</b>${codeLine}\n   ð <a href="${d.url}">Grab deal</a>`;
  });
  return `${imgLink}ð¥ <b>${deals.length} New Deals Alert!</b>\n\n` + lines.join('\n\n');
}

function buildFacebookMessage(deals) {
  if (deals.length === 0) return null;

  if (deals.length === 1) {
    const d = deals[0];
    const codeLine = d.promoCode ? `\nð·ï¸ Code: ${d.promoCode}` : '';
    return `ð¥ New Deal Alert!\n\nðï¸ ${d.title || 'Amazon Deal'}\n\nð° ${d.price || 'Check link'}${codeLine}\n\nð ${d.url}\n\n#deals #amazon #dealsaholic #shopping #sale`;
  }

  const lines = deals.map((d, i) => {
    const codeLine = d.promoCode ? `\n   ð·ï¸ Code: ${d.promoCode}` : '';
    return `${i + 1}. ðï¸ ${d.title || 'Amazon Deal'}\n   ð° ${d.price || 'Check link'}${codeLine}\n   ð ${d.url}`;
  });
  return `ð¥ ${deals.length} New Deals Alert!\n\n` + lines.join('\n\n') + '\n\n#deals #amazon #dealsaholic #shopping #sale';
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

  const content = (emailBody || title).trim();

  let claudeData = null;
  let rawSnippet = snippet;
  const jsonStr = extractJson(content);
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.title || parsed.amazonUrl) claudeData = parsed;
      if (parsed.snippet) rawSnippet = parsed.snippet;
      if (parsed.emailSnippet) rawSnippet = rawSnippet || parsed.emailSnippet;
      if (parsed.emailBody) {
        emailBody = parsed.emailBody;
        try {
          const inner = JSON.parse(extractJson(parsed.emailBody));
          if (inner && typeof inner === 'object' && (inner.title || inner.amazonUrl)) claudeData = inner;
        } catch (e) {}
      }
    }
  } catch (e) {}

  const plainText = stripHtml(content);
  const allUrls = [];
  if (claudeData?.amazonUrl) allUrls.push(claudeData.amazonUrl);
  extractAmazonUrls(content).forEach(u => allUrls.push(u));
  extractAmazonUrls(plainText).forEach(u => allUrls.push(u));
  if (rawSnippet) {
    extractAmazonUrls(rawSnippet).forEach(u => allUrls.push(u));
    extractAmazonUrls(stripHtml(rawSnippet)).forEach(u => allUrls.push(u));
  }

  const uniqueUrls = [...new Set(allUrls)];
  const primaryUrl = uniqueUrls[0] || null;
  let primaryMeta = null;
  if (primaryUrl) primaryMeta = await fetchAmazonMeta(primaryUrl);

  const sharedPrice = claudeData?.price || primaryMeta?.price || plainText.match(/\$[\d,.]+/)?.[0] || null;
  const originalPrice = claudeData?.originalPrice || null;
  const discount = claudeData?.discount || plainText.match(/(\d+)\s*%\s*(?:off|discount)/i)?.[1] || null;

  // Promo code: priority â explicit Claude field â email text (multi-pattern) â Amazon page scrape
  const discountCode = claudeData?.discountCode
    || extractPromoCodeFromText(plainText)
    || primaryMeta?.promoCode
    || null;

  const store = getStore("submissions");
  const urlsToProcess = uniqueUrls.length > 0 ? uniqueUrls.slice(0, 20) : [null];
  const savedIds = [];
  const deals = [];

  for (const dealUrl of urlsToProcess) {
    let meta = dealUrl === primaryUrl ? primaryMeta : null;
    if (!meta && dealUrl) meta = await fetchAmazonMeta(dealUrl);
    const asin = dealUrl?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || meta?.asin || null;
    const affiliateUrl = asin
      ? 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20'
      : dealUrl
      ? (dealUrl.includes('tag=') ? dealUrl : dealUrl + (dealUrl.includes('?') ? '&' : '?') + 'tag=kethya08-20')
      : '';
    // Prefer clean ASIN-based CDN URL â scraped OG URLs often contain special chars
    // that fail Make.com's URL validator
    const imageUrl = (asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg' : null) || meta?.image || null;
    const dealTitle = meta?.title
      || (dealUrl === primaryUrl ? claudeData?.title : null)
      || plainText.split(/[\n.!?]/).find(l => l.trim().length > 10 && !l.includes('http'))?.trim().substring(0, 150)
      || 'Amazon Deal';
    const dealPrice = meta?.price || (dealUrl === primaryUrl ? claudeData?.price : null) || sharedPrice;
    // Per-deal promo code: shared code from email, or code scraped from this deal's page
    const dealPromoCode = discountCode || meta?.promoCode || null;

    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id, title: dealTitle, price: dealPrice || null, originalPrice: originalPrice || null,
      discount: discount || null, url: affiliateUrl, imageUrl,
      discountCode: dealPromoCode || null,
      source: "email", status: affiliateUrl ? "approved" : "pending", sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await store.setJSON(id, submission);
    savedIds.push(id);
    deals.push({ id, title: dealTitle, price: dealPrice || null, url: affiliateUrl, imageUrl, promoCode: dealPromoCode });
    let index = [];
    try { index = await store.get("index", { type: "json" }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);
    await new Promise(r => setTimeout(r, 10));
  }

  const telegramMessage = buildTelegramMessage(deals);
  const facebookMessage = buildFacebookMessage(deals);

  return new Response(JSON.stringify({
    success: true, count: deals.length, ids: savedIds, deals,
    amazonUrlsFound: uniqueUrls.length,
    telegramMessage, facebookMessage,
    title: deals[0]?.title || null,
    price: deals[0]?.price || null,
    url: deals[0]?.url || null,
    imageUrl: deals[0]?.imageUrl || null,
    promoCode: deals[0]?.promoCode || null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/submit-email-deal" };
