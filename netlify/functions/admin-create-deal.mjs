import { getStore } from "@netlify/blobs";

const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

const WALMART_AFFILIATE = "https://goto.walmart.com/c/1788825/1398372/16662?u=";
const TEMU_AFFILIATE = "https://temuaffiliateprogram.pxf.io/c/1788825/1580294/18350?u=";

function detectStore(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("amazon.")) return "amazon";
    if (host.includes("walmart.")) return "walmart";
    if (host.includes("temu.")) return "temu";
    if (host.includes("goto.walmart.")) return "walmart_affiliate";
    if (host.includes("temuaffiliateprogram.")) return "temu_affiliate";
    return "other";
  } catch {
    return "other";
  }
}

// ✅ NEW: Visit promocode page and grab FIRST product ASIN only
async function resolvePromocodeToFirstAsin(promocodeUrl) {
  try {
    const res = await fetch(promocodeUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/\/dp\/([A-Z0-9]{10})/i);
    if (!match) return null;
    const asin = match[1];
    console.log(`Resolved promocode ${promocodeUrl} → ASIN ${asin}`);
    return asin;
  } catch (e) {
    console.error('resolvePromocodeToFirstAsin failed:', e.message);
    return null;
  }
}

function buildAffiliateUrl(url, store) {
  switch (store) {
    case "amazon": {
      const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
      const asin = asinMatch ? asinMatch[1] : null;
      if (asin) return `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`;
      return url.includes("tag=") ? url : `${url}${url.includes("?") ? "&" : "?"}tag=${PARTNER_TAG}`;
    }
    case "walmart":
      return `${WALMART_AFFILIATE}${encodeURIComponent(url)}`;
    case "temu":
      return `${TEMU_AFFILIATE}${encodeURIComponent(url)}`;
    default:
      return url;
  }
}

async function getAmazonAccessToken() {
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

async function fetchAmazonImage(asin) {
  try {
    const accessToken = await getAmazonAccessToken();
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
        resources: ["images.primary.large", "itemInfo.title"],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || data.searchResult?.items || [];
    return items[0]?.images?.primary?.large?.url || null;
  } catch (e) {
    console.log("Amazon image fetch failed:", e.message);
    return null;
  }
}

async function fetchPageImage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    const twitterMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    if (twitterMatch) return twitterMatch[1];
    return null;
  } catch (e) {
    console.log("Page image fetch failed:", e.message);
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

    let { title, url, photoUrl, price, originalPrice, discount, discountCode, expiresOn } = body;

    // ✅ NEW: Handle amazon.com/promocode/ URLs
    const isPromocodeUrl = /amazon\.com\/promocode\//i.test(url);
    let resolvedAsin = null;

    if (isPromocodeUrl) {
      console.log("Detected promocode URL, resolving to first product ASIN...");
      resolvedAsin = await resolvePromocodeToFirstAsin(url);
      if (resolvedAsin) {
        // Replace the promocode URL with the real product URL
        url = `https://www.amazon.com/dp/${resolvedAsin}?tag=${PARTNER_TAG}`;
        console.log(`Replaced promocode URL with: ${url}`);
      } else {
        console.log("Could not resolve promocode URL to ASIN");
      }
    }

    const store = detectStore(url);
    const affiliateUrl = buildAffiliateUrl(url, store);

    let imageUrl = photoUrl || null;

    if (!imageUrl) {
      if (store === "amazon") {
        // ✅ Use resolved ASIN if available, otherwise extract from URL
        const asin = resolvedAsin || url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
        if (asin) {
          console.log("Fetching Amazon image for ASIN:", asin);
          imageUrl = await fetchAmazonImage(asin);
          // Fallback to direct Amazon image URL
          if (!imageUrl) {
            imageUrl = `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`;
          }
        }
      } else if (store === "walmart" || store === "temu") {
        console.log("Fetching page image for:", url);
        imageUrl = await fetchPageImage(url);
      }
    }

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

    const blobStore = getStore("submissions");
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
      storeType: store,
      status: "approved",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: expiresOnISO,
    };

    await blobStore.setJSON(id, submission);

    let index = [];
    try {
      index = await blobStore.get("index", { type: "json" }) || [];
    } catch (e) { index = []; }
    index.unshift(id);
    await blobStore.setJSON("index", index);

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
