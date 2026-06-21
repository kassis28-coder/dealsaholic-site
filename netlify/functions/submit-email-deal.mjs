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
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.title || parsed.amazonUrl) claudeData = parsed;
      if (parsed.snippet) rawSnippet = parsed.snippet;
      if (parsed.emailSnippet) rawSnippet = rawSnippet || parsed.emailSnippet;
      if (parsed.emailBody) {
        emailBody = parsed.emailBody;
        try {
          const inner = JSON.parse(parsed.emailBody);
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
  const discountCode = claudeData?.discountCode || plainText.match(/(?:code|coupon|promo)[:\s]+([A-Z0-9]{4,20})/i)?.[1] || null;

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
    const imageUrl = meta?.image || (asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg' : null);
    const dealTitle = meta?.title
      || (dealUrl === primaryUrl ? claudeData?.title : null)
      || plainText.split(/[\n.!?]/).find(l => l.trim().length > 10 && !l.includes('http'))?.trim().substring(0, 150)
      || 'Amazon Deal';
    const dealPrice = meta?.price || (dealUrl === primaryUrl ? claudeData?.price : null) || sharedPrice;
    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id, title: dealTitle, price: dealPrice || null, originalPrice: originalPrice || null,
      discount: discount || null, url: affiliateUrl, imageUrl, discountCode: discountCode || null,
      source: "email", status: affiliateUrl ? "approved" : "pending", sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await store.setJSON(id, submission);
    savedIds.push(id);
    deals.push({ id, title: dealTitle, price: dealPrice || null, url: affiliateUrl, imageUrl });
    let index = [];
    try { index = await store.get("index", { type: "json" }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);
    await new Promise(r => setTimeout(r, 10));
  }

  const telegramMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 <b>New Deal Alert!</b>\n\n🛍️ <b>${deals[0].title || 'Amazon Deal'}</b>\n\n💰 <b>${deals[0].price || 'Check link'}</b>\n\n🔗 <a href="${deals[0].url}">👉 Grab this deal!</a>`
      : `🔥 <b>${deals.length} New Deals Alert!</b>\n\n` + deals.map((d, i) =>
          `${i + 1}. 🛍️ <b>${d.title || 'Amazon Deal'}</b>\n   💰 <b>${d.price || 'Check link'}</b>\n   🔗 <a href="${d.url}">Grab deal</a>`
        ).join('\n\n');

  const facebookMessage = deals.length === 0 ? null
    : deals.length === 1
      ? `🔥 New Deal Alert!\n\n🛍️ ${deals[0].title || 'Amazon Deal'}\n\n💰 ${deals[0].price || 'Check link'}\n\n👉 ${deals[0].url}\n\n#deals #amazon #dealsaholic #shopping #sale`
      : `🔥 ${deals.length} New Deals Alert!\n\n` + deals.map((d, i) =>
          `${i + 1}. 🛍️ ${d.title || 'Amazon Deal'}\n   💰 ${d.price || 'Check link'}\n   👉 ${d.url}`
        ).join('\n\n') + '\n\n#deals #amazon #dealsaholic #shopping #sale';

  return new Response(JSON.stringify({
    success: true, count: deals.length, ids: savedIds, deals,
    amazonUrlsFound: uniqueUrls.length,
    telegramMessage, facebookMessage,
    title: deals[0]?.title || null, price: deals[0]?.price || null,
    url: deals[0]?.url || null, imageUrl: deals[0]?.imageUrl || null,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/submit-email-deal" };
