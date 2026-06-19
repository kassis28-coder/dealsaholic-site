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
        resources: [
          "images.primary.large",
          "itemInfo.title",
        ],
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

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();

    if (body.password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    let { title, url, price, originalPrice, discount, discountCode, expiresOn } = body;

    // Extract ASIN from Amazon URL
    const asinMatch = (url || "").match(/\/dp\/([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1] : null;

    // Build affiliate URL
    const affiliateUrl = asin
      ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
      : url.includes("tag=") ? url : `${url}${url.includes("?") ? "&" : "?"}tag=kethya08-20`;

    // Auto-fetch image from Amazon API using ASIN
    let imageUrl = null;
    if (asin) {
      console.log("Fetching image for ASIN:", asin);
      imageUrl = await getProductImage(asin);
      console.log("Image URL fetched:", imageUrl);
    }

    // Handle expiry date MM/DD/YYYY or YYYY-MM-DD
    let expiresOnISO;
    if (expiresOn) {
      if (expiresOn.includes('/')) {
        const parts = expiresOn.split('/');
        if (parts.length === 3) {
          expiresOnISO = `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}T23:59:59.000Z`;
        }
      } else {
        expiresOnISO = new Date(expiresOn).toISOString();
      }
    }
    if (!expiresOnISO) {
      expiresOnISO = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    // Save to Netlify Blobs
    const store = getStore("submissions");

    const id = `admin-${Date.now()}`;
    const submission = {
      id,
      title,
      price,
      originalPrice,
      discount,
      url: affiliateUrl,
      imageUrl: imageUrl || null,
      discountCode: discountCode || null,
      source: "admin",
      status: "approved",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: expiresOnISO,
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
    console.error("admin-create-deal error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/admin-create-deal",
};
