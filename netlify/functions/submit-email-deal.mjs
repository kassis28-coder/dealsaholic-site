import { getStore } from "@netlify/blobs";

async function fetchAmazonMeta(amazonUrl) {
  try {
    const res = await fetch(amazonUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();

    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
      || null;

    const image = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || null;

    const priceMatch = html.match(/["']priceAmount["']\s*:\s*["']?([\d.]+)["']?/)
      || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;

    return {
      title: title?.replace(/\s*[|:–-].*amazon.*/i, '').trim().substring(0, 150) || null,
      image: image || null,
      price,
    };
  } catch (e) {
    return null;
  }
}

export default async (req, context) => {
  const url = new URL(req.url);

  let emailBody = '';
  let title = '';

  if (req.method === 'GET') {
    emailBody = url.searchParams.get('emailBody') || '';
    title = url.searchParams.get('title') || '';
  } else if (req.method === 'POST') {
    try { emailBody = await req.text(); } catch (e) { emailBody = ''; }
  }

  const content = (emailBody || title).trim();

  // Try to parse as JSON (Claude's output from Make.com)
  let claudeData = null;
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && (parsed.title || parsed.amazonUrl)) {
      claudeData = parsed;
    }
  } catch (e) {}

  // Strip HTML tags to get plain text
  const plainText = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();

  // Extract Amazon URLs
  const amazonPatterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
  ];

  const allUrls = [];
  for (const pattern of amazonPatterns) {
    [...content.matchAll(new RegExp(pattern.source, 'gi'))].forEach(m => allUrls.push(m[0]));
    [...plainText.matchAll(new RegExp(pattern.source, 'gi'))].forEach(m => allUrls.push(m[0]));
  }
  if (claudeData?.amazonUrl) allUrls.unshift(claudeData.amazonUrl);

  const uniqueUrls = [...new Set(allUrls)];
  const primaryUrl = uniqueUrls[0] || null;
  const primaryAsin = primaryUrl?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;

  const isUrlOnly = uniqueUrls.length > 0 && plainText.replace(/https?:\/\/[^\s]+/g, '').trim().length < 10;

  // Fetch Amazon metadata if we only have a URL
  let amazonMeta = null;
  if (primaryUrl && !claudeData) {
    amazonMeta = await fetchAmazonMeta(primaryUrl);
  }

  // Deal fields: Claude > Amazon meta > regex
  const dealTitle = claudeData?.title
    || amazonMeta?.title
    || plainText.split(/[\n.!?]/).find(l => l.trim().length > 10 && !l.includes('http'))?.trim().substring(0, 150)
    || 'Amazon Deal';

  const price = claudeData?.price || amazonMeta?.price || plainText.match(/\$[\d,.]+/)?.[0] || null;
  const originalPrice = claudeData?.originalPrice || null;
  const discount = claudeData?.discount || plainText.match(/(\d+)\s*%\s*(?:off|discount)/i)?.[1] || null;
  const discountCode = claudeData?.discountCode
    || plainText.match(/(?:code|coupon|promo)[:\s]+([A-Z0-9]{4,20})/i)?.[1] || null;

  // Save to Netlify Blobs
  const store = getStore("submissions");
  const urlsToProcess = uniqueUrls.length > 0 ? uniqueUrls.slice(0, 10) : [null];
  const savedIds = [];
  let firstImageUrl = null;
  let firstAffiliateUrl = null;

  for (const dealUrl of urlsToProcess) {
    const dealAsin = dealUrl?.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;

    const dealAffiliateUrl = dealAsin
      ? `https://www.amazon.com/dp/${dealAsin}?tag=kethya08-20`
      : dealUrl
        ? (dealUrl.includes('tag=') ? dealUrl : `${dealUrl}${dealUrl.includes('?') ? '&' : '?'}tag=kethya08-20`)
        : '';

    const imageUrl = amazonMeta?.image
      || (dealAsin ? `https://m.media-amazon.com/images/P/${dealAsin}.01._SCLZZZZZZZ_.jpg` : null);

    if (!firstImageUrl && imageUrl) firstImageUrl = imageUrl;
    if (!firstAffiliateUrl && dealAffiliateUrl) firstAffiliateUrl = dealAffiliateUrl;

    const id = `email-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const submission = {
      id,
      title: dealTitle,
      price: price || null,
      originalPrice: originalPrice || null,
      discount: discount || null,
      url: dealAffiliateUrl,
      imageUrl,
      discountCode: discountCode || null,
      source: "email",
      status: dealAffiliateUrl ? "approved" : "pending",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.setJSON(id, submission);
    savedIds.push(id);

    let index = [];
    try { index = await store.get("index", { type: "json" }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);
    await new Promise(r => setTimeout(r, 10));
  }

  return new Response(JSON.stringify({
    success: true, count: savedIds.length, ids: savedIds,
    amazonUrlsFound: uniqueUrls.length,
    title: dealTitle, price: price || null,
    url: firstAffiliateUrl, imageUrl: firstImageUrl,
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};

export const config = { path: "/api/submit-email-deal" };
