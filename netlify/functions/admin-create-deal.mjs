import { getStore } from "@netlify/blobs";

const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || 'daholic-20';
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

const WALMART_AFFILIATE = process.env.WALMART_IMPACT_PREFIX || "https://goto.walmart.com/c/1788825/1398372/16662?u=";
const TARGET_AFFILIATE = process.env.TARGET_IMPACT_PREFIX || "";
const TEMU_AFFILIATE = "https://temuaffiliateprogram.pxf.io/c/1788825/1580294/18350?u=";

function detectStore(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("goto.walmart.")) return "walmart_affiliate";
    if (host.includes("goto.target.") || host.includes("target.sjv.io")) return "target_affiliate";
    if (host === "mavely.app.link" || host.endsWith(".mavely.app.link") || host.includes("mavelyinfluencer.com")) return "target_affiliate";
    if (host.includes("temuaffiliateprogram.")) return "temu_affiliate";
    if (host.includes("amazon.")) return "amazon";
    if (host.includes("walmart.")) return "walmart";
    if (host.includes("target.")) return "target";
    if (host.includes("temu.")) return "temu";
    return "other";
  } catch {
    return "other";
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
    case "target":
      if (!TARGET_AFFILIATE) throw new Error("Target Impact link is not configured. Paste an already-tracked Target Impact link or add TARGET_IMPACT_PREFIX in Netlify.");
      return `${TARGET_AFFILIATE}${encodeURIComponent(url)}`;
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

// ✅ Search Amazon by title using Creator API
async function searchAmazonByTitle(title) {
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
        keywords: title,
        itemCount: 1,
        partnerTag: PARTNER_TAG,
        partnerType: "Associates",
        marketplace: MARKETPLACE,
        resources: [
          "images.primary.large",
          "itemInfo.title",
          "offersV2.listings.price",
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || data.searchResult?.items || [];
    if (!items[0]) return null;
    const item = items[0];
    console.log(`Title search found ASIN: ${item.asin}`);
    return amazonItemFields(item);
  } catch (e) {
    console.error('searchAmazonByTitle failed:', e.message);
    return null;
  }
}

function formatMoney(amount, displayAmount) {
  if (displayAmount && String(displayAmount).trim()) return String(displayAmount).trim();
  const value = Number(amount);
  return Number.isFinite(value) && value > 0 ? `$${value.toFixed(2)}` : null;
}

function normalizePriceText(value) {
  const text = String(value || '').trim();
  if (!text || text.toLowerCase() === 'check price') return text;
  // Covers individual prices and typed ranges such as "9.60-25.20".
  return text.replace(/(^|[-–—]\s*)(\d+(?:\.\d{1,2})?)(?![\d.])/g, (match, prefix, amount) => {
    return `${prefix}${amount.startsWith('$') ? amount : `$${amount}`}`;
  });
}

function amazonItemFields(item) {
  if (!item) return null;
  const listing = item.offersV2?.listings?.[0] || {};
  const currentAmount = listing.price?.money?.amount;
  const savingsAmount = listing.price?.savings?.money?.amount;
  const currentPrice = formatMoney(currentAmount, listing.price?.money?.displayAmount);
  const originalPrice = Number.isFinite(Number(currentAmount)) && Number.isFinite(Number(savingsAmount)) && Number(savingsAmount) > 0
    ? `$${(Number(currentAmount) + Number(savingsAmount)).toFixed(2)}`
    : null;
  const discount = Number.isFinite(Number(listing.price?.savings?.percentage))
    ? String(Math.round(Number(listing.price.savings.percentage)))
    : (Number.isFinite(Number(currentAmount)) && Number.isFinite(Number(savingsAmount)) && Number(currentAmount) + Number(savingsAmount) > 0
      ? String(Math.round((Number(savingsAmount) / (Number(currentAmount) + Number(savingsAmount))) * 100))
      : null);
  const asin = item.asin || null;
  const image = item.images?.primary?.large?.url ||
    item.images?.primary?.medium?.url ||
    (asin ? `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg` : null);
  return {
      asin,
      image,
      title: item.itemInfo?.title?.displayValue || null,
      url: `https://www.amazon.com/dp/${asin}?tag=${PARTNER_TAG}`,
      price: currentPrice,
      originalPrice,
      discount,
    };
}

async function fetchAmazonItem(asin) {
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
        resources: [
          "images.primary.large",
          "images.primary.medium",
          "itemInfo.title",
          "offersV2.listings.price",
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.items || data.searchResult?.items || [];
    const matched = items.find(item => String(item.asin || '').toUpperCase() === String(asin).toUpperCase()) || items[0];
    return amazonItemFields(matched);
  } catch (e) {
    console.log("Amazon item fetch failed:", e.message);
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

    title = String(title || '').trim();
    url = String(url || '').trim();
    price = normalizePriceText(price);
    originalPrice = normalizePriceText(originalPrice);
    discount = String(discount || '').trim();

    if (!title || !url) {
      return new Response(JSON.stringify({ error: "Product title and URL are required" }), { status: 400 });
    }

    let imageUrl = photoUrl || null;
    let finalUrl = url;
    let resolvedAsin = null;

    // ✅ Handle promocode URLs — search by title
    const isPromocodeUrl = /amazon\.com\/promocode\//i.test(url);
    if (isPromocodeUrl && title) {
      console.log("Promocode URL detected, searching by title:", title);
      const searchResult = await searchAmazonByTitle(title);
      if (searchResult) {
        resolvedAsin = searchResult.asin;
        finalUrl = searchResult.url;
        if (!imageUrl) imageUrl = searchResult.image;
        console.log(`Resolved via title search → ASIN ${resolvedAsin}`);
      } else {
        console.log("Title search failed");
      }
    }

    const store = detectStore(finalUrl);
    const affiliateUrl = buildAffiliateUrl(finalUrl, store);

    // Amazon's Creator API supplies the live offer price for manual Amazon
    // submissions. This means the editor can paste a product URL without
    // retyping the price. Manual values always win when the API has no data.
    let amazonDetails = null;
    if (store === "amazon") {
      const asinFromUrl = resolvedAsin || finalUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
      if (asinFromUrl) amazonDetails = await fetchAmazonItem(asinFromUrl);
      if (!amazonDetails && title) amazonDetails = await searchAmazonByTitle(title);

      if (amazonDetails) {
        resolvedAsin = resolvedAsin || amazonDetails.asin;
        if (!price) price = amazonDetails.price || '';
        if (!originalPrice) originalPrice = amazonDetails.originalPrice || '';
        if (!discount) discount = amazonDetails.discount || '';
        if (!imageUrl) imageUrl = amazonDetails.image || null;
      }

      if (!price) {
        return new Response(JSON.stringify({
          error: "Amazon price could not be found automatically. Please enter the current price and try again.",
        }), { status: 422, headers: { "Content-Type": "application/json" } });
      }
    }

    // Get image if still missing
    if (!imageUrl) {
      if (store === "amazon") {
        const asin = resolvedAsin || finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
        if (asin) {
          const fetched = amazonDetails || await fetchAmazonItem(asin);
          imageUrl = fetched?.image || null;
          if (!imageUrl) {
            imageUrl = `https://m.media-amazon.com/images/P/${asin}.01._SCLZZZZZZZ_.jpg`;
          }
        }
      } else if (store === "walmart" || store === "target" || store === "temu") {
        imageUrl = await fetchPageImage(finalUrl);
      }
    }

    // Get ASIN from final URL
    const asin = resolvedAsin
      || affiliateUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]
      || null;

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
    const queueStore = getStore("deal-queue");
    const id = `admin-${Date.now()}`;

    const submission = {
      id,
      asin: asin || null,   // real ASIN only — never the internal id
      title,
      price,
      originalPrice,
      discount,
      url: affiliateUrl,
      productUrl: url,      // preserve the original submitted URL
      imageUrl: imageUrl || null,
      discountCode: discountCode || null,
      source: "admin",
      storeType: store.replace('_affiliate', ''),
      status: "approved",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: expiresOnISO,
    };

    await blobStore.setJSON(id, submission);

    // Update index
    let index = [];
    try {
      index = await blobStore.get("index", { type: "json" }) || [];
    } catch (e) { index = []; }
    index.unshift(id);
    await blobStore.setJSON("index", index);

    // ✅ NEW: Add to queue for Telegram/Facebook posting
    // Only queue if we have all required info
    if (affiliateUrl && imageUrl && title) {
      try {
        let queue = [];
        try {
          queue = await queueStore.get('queue', { type: 'json' }) || [];
        } catch(e) { queue = []; }

        queue.push({
          id,
          title,
          price: price || null,
          originalPrice: originalPrice || null,
          discount: discount || null,
          url: affiliateUrl,
          imageUrl,
          promoCode: discountCode || null,
          asin,
          store: store.replace('_affiliate', ''),
        });

        await queueStore.setJSON('queue', queue);
        console.log(`Added admin deal to queue: ${title}`);
      } catch(e) {
        console.error('Queue write failed:', e.message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      id,
      deal: submission,
      resolvedFromPromocode: isPromocodeUrl,
      queuedForPosting: !!(affiliateUrl && imageUrl && title),
    }), {
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
