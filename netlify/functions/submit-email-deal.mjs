import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  // Accept both GET and POST
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

  // Extract Amazon URL
  const amazonPatterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
  ];

  let amazonUrl = null;
  for (const pattern of amazonPatterns) {
    const match = content.match(pattern);
    if (match) {
      amazonUrl = match[0];
      break;
    }
  }

  // Extract ASIN
  const asinMatch = (amazonUrl || '').match(/\/dp\/([A-Z0-9]{10})/i);
  const asin = asinMatch ? asinMatch[1] : null;

  // Build affiliate URL
  const affiliateUrl = asin
    ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
    : amazonUrl
    ? (amazonUrl.includes('tag=') ? amazonUrl : `${amazonUrl}${amazonUrl.includes('?') ? '&' : '?'}tag=kethya08-20`)
    : null;

  // Extract price
  const priceMatch = content.match(/\$[\d,.]+/);
  const price = priceMatch ? priceMatch[0] : null;

  // Extract discount
  const discountMatch = content.match(/(\d+)\s*%\s*off/i);
  const discount = discountMatch ? discountMatch[1] : null;

  // Extract promo code
  const codeMatch = content.match(/(?:code|coupon|promo)[:\s]+([A-Z0-9]{4,20})/i);
  const discountCode = codeMatch ? codeMatch[1] : null;

  // Use first line as title if no title provided
  const dealTitle = title || content.split('\n')[0].trim().substring(0, 150) || 'Amazon Deal';

  // Save to Netlify Blobs even without Amazon URL
  const { getStore } = await import("@netlify/blobs");
  const store = getStore("submissions");

  const id = `email-${Date.now()}`;
  const submission = {
    id,
    title: dealTitle,
    price: price || null,
    originalPrice: null,
    discount: discount || null,
    url: affiliateUrl || amazonUrl || '',
    imageUrl: null,
    discountCode: discountCode || null,
    source: "email",
    status: affiliateUrl ? "approved" : "pending",
    sponsored: false,
    createdAt: new Date().toISOString(),
    expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    rawContent: content.substring(0, 500),
  };

  await store.setJSON(id, submission);

  // Update index
  let index = [];
  try {
    index = await store.get("index", { type: "json" }) || [];
  } catch (e) { index = []; }
  index.unshift(id);
  await store.setJSON("index", index);

  return new Response(JSON.stringify({ success: true, id, deal: submission }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config = {
  path: "/api/submit-email-deal",
};
