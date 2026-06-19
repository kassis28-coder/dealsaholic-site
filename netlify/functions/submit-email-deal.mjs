import { getStore } from "@netlify/blobs";

const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

async function getAccessToken() {
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
  if (!res.ok) throw new Error(`Token request failed (${res.status})`);
  const data = await res.json();
  return data.access_token;
}

async function getProductImage(asin) {
  try {
    const accessToken = await getAccessToken();
    const res = await fetch(CATALOG_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "x-marketplace": MARKETPLACE,
      },
      body: JSON.stringify({
        keywords: asin,
        itemCount: 1,
        partnerTag: PARTNER_TAG,
        partnerType: "Associates",
        marketplace: MARKETPLACE,
        resources: ["images.primary.large"],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || data.searchResult?.items || [];
    if (items.length > 0) {
      return items[0].images?.primary?.large?.url || null;
    }
    return null;
  } catch (e) {
    console.log("Amazon image fetch failed:", e.message);
    return null;
  }
}

function extractAmazonUrl(text) {
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/([A-Z0-9]{10})[^\s]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function extractASIN(url) {
  const match = (url || '').match(/\/dp\/([A-Z0-9]{10})/i);
  return match ? match[1] : null;
}

function extractPrice(text) {
  const match = text.match(/\$[\d,.]+/);
  return match ? match[0] : null;
}

function extractDiscount(text) {
  const match = text.match(/(\d+)\s*%\s*off/i);
  return match ? match[1] : null;
}

function extractCode(text) {
  const match = text.match(/(?:code|coupon|promo)[:\s]+([A-Z0-9]{4,20})/i);
  return match ? match[1] : null;
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    
    // Handle both old format (title as JSON string from Claude)
    // and new format (raw email text)
    let title, price, originalPrice, discount, amazonUrl, discountCode, imageUrl;
    
    const rawContent = body.title || body.content || '';
    
    // Try to parse as JSON first (Claude's structured response)
    let parsed = null;
    try {
      const clean = rawContent.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      // Not JSON — treat as raw email text
    }
    
    if (parsed) {
      // Structured data from Claude
      title = parsed.title;
      price = parsed.price;
      originalPrice = parsed.originalPrice;
      discount = parsed.discount;
      amazonUrl = parsed.amazonUrl;
      discountCode = parsed.discountCode;
      imageUrl = parsed.imageUrl;
    } else {
      // Raw email text — extract what we can
      amazonUrl = extractAmazonUrl(rawContent);
      price = extractPrice(rawContent);
      discount = extractDiscount(rawContent);
      discountCode = extractCode(rawContent);
      title = rawContent.split('\n')[0].trim().substring(0, 100) || 'Amazon Deal';
    }

    // Extract ASIN
    const asin = extractASIN(amazonUrl);

    // Build affiliate URL
    const affiliateUrl = asin
      ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
      : amazonUrl
      ? (amazonUrl.includes('tag=') ? amazonUrl : `${amazonUrl}${amazonUrl.includes('?') ? '&' : '?'}tag=kethya08-20`)
      : null;

    if (!affiliateUrl) {
      return new Response(JSON.stringify({ error: "No Amazon URL found in email" }), { status: 400 });
    }

    // Auto-fetch image from Amazon API
    if (asin && !imageUrl) {
      imageUrl = await getProductImage(asin);
    }

    // Save to Netlify Blobs
    const store = getStore("submissions");
    const id = `email-${Date.now()}`;
    const submission = {
      id,
      title: title || 'Amazon Deal',
      price: price || null,
      originalPrice: originalPrice || null,
      discount: discount || null,
      url: affiliateUrl,
      imageUrl: imageUrl || null,
      discountCode: discountCode || null,
      source: "email",
      status: "approved",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
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

  } catch (err) {
    console.error("submit-email-deal error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/submit-email-deal",
};
