import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const url = new URL(req.url);

  let emailBody = '';
  let title = '';

  if (req.method === 'GET') {
    emailBody = url.searchParams.get('emailBody') || '';
    title = url.searchParams.get('title') || '';
  } else if (req.method === 'POST') {
    try {
      emailBody = await req.text();
    } catch (e) {
      emailBody = '';
    }
  }

  const content = emailBody || title;

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
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract Amazon URLs from HTML and plain text
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

  // Prepend Claude's amazonUrl if provided
  if (claudeData?.amazonUrl) allUrls.unshift(claudeData.amazonUrl);

  const uniqueUrls = [...new Set(allUrls)];

  // Deal fields: prefer Claude data, fall back to regex extraction
  const dealTitle = claudeData?.title
    || plainText.split(/[\n.!?]/).find(l => l.trim().length > 10)?.trim().substring(0, 150)
    || 'Amazon Deal';

  const price = claudeData?.price || plainText.match(/\$[\d,.]+/)?.[0] || null;
  const originalPrice = claudeData?.originalPrice || null;
  const discount = claudeData?.discount || plainText.match(/(\d+)\s*%\s*(?:off|discount)/i)?.[1] || null;
  const discountCode = claudeData?.discountCode
    || plainText.match(/(?:code|coupon|promo)[:\s]+([A-Z0-9]{4,20})/i)?.[1]
    || null;

  // Save to Netlify Blobs
  const store = getStore("submissions");
  const urlsToProcess = uniqueUrls.length > 0 ? uniqueUrls.slice(0, 10) : [null];
  const savedIds = [];
  let firstImageUrl = null;
  let firstAffiliateUrl = null;

  for (const dealUrl of urlsToProcess) {
    const dealAsin = (dealUrl || '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;

    const dealAffiliateUrl = dealAsin
      ? `https://www.amazon.com/dp/${dealAsin}?tag=kethya08-20`
      : dealUrl
        ? (dealUrl.includes('tag=') ? dealUrl : `${dealUrl}${dealUrl.includes('?') ? '&' : '?'}tag=kethya08-20`)
        : '';

    // Amazon product image via standard CDN pattern
    const imageUrl = dealAsin
      ? `https://m.media-amazon.com/images/P/${dealAsin}.01._SCLZZZZZZZ_.jpg`
      : null;

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
    success: true,
    count: savedIds.length,
    ids: savedIds,
    amazonUrlsFound: uniqueUrls.length,
    title: dealTitle,
    price: price || null,
    url: firstAffiliateUrl,
    imageUrl: firstImageUrl,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  path: "/api/submit-email-deal",
};import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const url = new URL(req.url);
  
  let emailBody = '';
  let title = '';
  
  if (req.method === 'GET') {
    emailBody = url.searchParams.get('emailBody') || '';
    title = url.searchParams.get('title') || '';
  } else if (req.method === 'POST') {
    try {
      emailBody = await req.text();
    } catch (e) {
      emailBody = '';
    }
  }

  const content = emailBody || title;

  // Strip HTML tags to get plain text
  const plainText = content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract ALL Amazon URLs from both HTML and plain text
  const amazonPatterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'<>]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
  ];

  // Search in both original HTML and plain text
  const allUrls = [];
  for (const pattern of amazonPatterns) {
    const matches = [...content.matchAll(new RegExp(pattern.source, 'gi'))];
    matches.forEach(m => allUrls.push(m[0]));
    const matches2 = [...plainText.matchAll(new RegExp(pattern.source, 'gi'))];
    matches2.forEach(m => allUrls.push(m[0]));
  }

  // Remove duplicates
  const uniqueUrls = [...new Set(allUrls)];
  const amazonUrl = uniqueUrls[0] || null;

  // Extract ASIN
  const asinMatch = (amazonUrl || '').match(/\/dp\/([A-Z0-9]{10})/i);
  const asin = asinMatch ? asinMatch[1] : null;

  // Build affiliate URL
  const affiliateUrl = asin
    ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
    : amazonUrl
    ? (amazonUrl.includes('tag=') ? amazonUrl : `${amazonUrl}${amazonUrl.includes('?') ? '&' : '?'}tag=kethya08-20`)
    : null;

  // Extract price from plain text
  const priceMatch = plainText.match(/\$[\d,.]+/);
  const price = priceMatch ? priceMatch[0] : null;

  // Extract discount
  const discountMatch = plainText.match(/(\d+)\s*%\s*(?:off|discount)/i);
  const discount = discountMatch ? discountMatch[1] : null;

  // Extract promo code
  const codeMatch = plainText.match(/(?:code|coupon|promo)[:\s]+([A-Z0-9]{4,20})/i);
  const discountCode = codeMatch ? codeMatch[1] : null;

  // Use first meaningful line as title
  const dealTitle = plainText.split(/[\n.!?]/).find(l => l.trim().length > 10)?.trim().substring(0, 150) || 'Amazon Deal';

  // Save to Netlify Blobs
  const store = getStore("submissions");

  // If multiple Amazon URLs found, save each as separate deal
  const urlsToProcess = uniqueUrls.length > 0 ? uniqueUrls.slice(0, 10) : [null];
  const savedIds = [];

  for (const dealUrl of urlsToProcess) {
    const dealAsin = (dealUrl || '').match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    const dealAffiliateUrl = dealAsin
      ? `https://www.amazon.com/dp/${dealAsin}?tag=kethya08-20`
      : dealUrl
      ? (dealUrl.includes('tag=') ? dealUrl : `${dealUrl}${dealUrl.includes('?') ? '&' : '?'}tag=kethya08-20`)
      : '';

    const id = `email-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const submission = {
      id,
      title: dealTitle,
      price: price || null,
      originalPrice: null,
      discount: discount || null,
      url: dealAffiliateUrl,
      imageUrl: null,
      discountCode: discountCode || null,
      source: "email",
      status: dealAffiliateUrl ? "approved" : "pending",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.setJSON(id, submission);
    savedIds.push(id);

    // Update index
    let index = [];
    try {
      index = await store.get("index", { type: "json" }) || [];
    } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);

    // Small delay to avoid duplicate timestamps
    await new Promise(r => setTimeout(r, 10));
  }

  return new Response(JSON.stringify({ 
    success: true, 
    count: savedIds.length,
    ids: savedIds,
    amazonUrlsFound: uniqueUrls.length,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  path: "/api/submit-email-deal",
};
