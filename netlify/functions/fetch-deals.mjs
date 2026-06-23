import { getStore } from "@netlify/blobs";

const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const MIN_DISCOUNT = Number(process.env.DEALS_MIN_DISCOUNT || 20);
const MAX_RESULTS = Number(process.env.DEALS_MAX_RESULTS || 300);
const MAX_AGE_HOURS = 168; // 7 days
const SUSPICIOUS_DISCOUNT = 85; // Flag deals with 80%+ discount for review

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

const ALL_CATEGORIES = [
  "deal of the day", "clearance", "today's deals", "electronics",
  "electronics accessories", "headphones", "home and kitchen", "kitchen gadgets",
  "small appliances", "best sellers", "home decor", "wall art", "furniture",
  "storage organization", "bathroom accessories", "bedroom furniture",
  "bedding sheets", "pillows comforters", "kitchen appliances deals",
  "living room furniture", "home improvement", "curtains blinds", "beauty",
  "skincare", "haircare tools", "toys", "toys for kids", "board games","perfumes",
"hair treatment",
  "fashion", "womens clothing", "mens clothing", "shoes", "sports and outdoors",
 "fitness equipment",
  "workout equipment",
  "yoga mats",
  "outdoor camping gear",
  "pet supplies",
  "kids clothing",
  "baby clothing",
  "baby gear",
  "vitamins supplements",
  "protein powder", "toilet paper",
  "paper towels", "laundry detergent", "dish soap", "cleaning supplies",
  "trash bags", "household essentials","winter clothing",
  "womens winter jackets",
  "womens boots",
  "womens shoes",
  "ankle boots",
  "sneakers women","skincare" 
];

const BATCH_SIZE = 7;
const BATCHES = [];
for (let i = 0; i < ALL_CATEGORIES.length; i += BATCH_SIZE) {
  BATCHES.push(ALL_CATEGORIES.slice(i, i + BATCH_SIZE));
}

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
  if (!res.ok) throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function searchItems(accessToken, keywords) {
  const res = await fetch(CATALOG_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-marketplace": MARKETPLACE,
    },
    body: JSON.stringify({
      keywords,
      itemCount: 10,
      partnerTag: PARTNER_TAG,
      partnerType: "Associates",
      marketplace: MARKETPLACE,
      resources: [
        "images.primary.large",
        "itemInfo.title",
        "offersV2.listings.price",
        "customerReviews.starRating",
        "customerReviews.count",
      ],
    }),
  });
  if (!res.ok) {
    console.error(`searchItems("${keywords}") failed (${res.status})`);
    return [];
  }
  const data = await res.json();
  return data.items || data.searchResult?.items || [];
}

async function scrapeRealPrice(asin) {
  try {
    const url = `https://www.amazon.com/dp/${asin}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const patterns = [
      /"priceAmount":([\d.]+)/,
      /class="a-price-whole">([0-9,]+)<\/span><span[^>]*class="a-price-fraction">(\d+)/,
      /"dealPrice":\{"value":([\d.]+)/,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        const price = pattern.toString().includes('price-whole')
          ? parseFloat(`${match[1].replace(',', '')}.${match[2]}`)
          : parseFloat(match[1].replace(',', ''));
        if (!isNaN(price) && price > 0) return price;
      }
    }
    return null;
  } catch (err) {
    return null;
  }
}

function computeDiscountPercent(item) {
  const listing = item.offersV2?.listings?.[0];
  if (!listing) return null;
  const savingsPercent = listing.price?.savings?.percentage;
  if (typeof savingsPercent === "number") return savingsPercent;
  const price = listing.price?.money?.amount;
  const savingsAmount = listing.price?.savings?.money?.amount;
  if (typeof price === "number" && typeof savingsAmount === "number") {
    const originalPrice = price + savingsAmount;
    if (originalPrice > 0) return Math.round((savingsAmount / originalPrice) * 100);
  }
  return null;
}

function normalizeDeal(item) {
  const listing = item.offersV2?.listings?.[0];
  const apiPrice = listing?.price?.money?.amount;
  const apiDisplayPrice = listing?.price?.money?.displayAmount;
  const savingsAmount = listing?.price?.savings?.money?.amount;
  const originalPriceAmount = apiPrice && savingsAmount ? apiPrice + savingsAmount : null;
  const discountPercent = computeDiscountPercent(item);

  return {
    asin: item.asin,
    title: item.itemInfo?.title?.displayValue || "Untitled product",
    image: item.images?.primary?.large?.url || null,
    price: apiDisplayPrice || null,
    apiPrice: apiPrice || null,
    originalPrice: originalPriceAmount ? `$${originalPriceAmount.toFixed(2)}` : null,
    discountPercent,
    rating: item.customerReviews?.starRating?.value || null,
    reviewCount: item.customerReviews?.count || null,
    url: item.detailPageURL || `https://www.amazon.com/dp/${item.asin}?tag=${PARTNER_TAG}`,
    fetchedAt: new Date().toISOString(),
    // Auto-flag suspicious deals
    needsReview: discountPercent !== null && discountPercent >= SUSPICIOUS_DISCOUNT,
    flagReason: discountPercent !== null && discountPercent >= SUSPICIOUS_DISCOUNT 
      ? `High discount (${discountPercent}%) - may be a price glitch` 
      : null,
  };
}

async function fetchAndStoreDeals() {
  const store = getStore("deals");

  let batchIndex = 0;
  try {
    const stateResult = await store.get("batch-state", { type: "json" });
    if (stateResult && typeof stateResult.nextBatchIndex === "number") {
      batchIndex = stateResult.nextBatchIndex;
    }
  } catch { }

  const batch = BATCHES[batchIndex % BATCHES.length];
  const nextBatchIndex = (batchIndex + 1) % BATCHES.length;

  console.error(`Running batch ${batchIndex + 1} of ${BATCHES.length}: ${JSON.stringify(batch)}`);

  const accessToken = await getAccessToken();

  const newItems = [];
  for (const category of batch) {
    const items = await searchItems(accessToken, category);
    newItems.push(...items);
    await new Promise((r) => setTimeout(r, 2500));
  }

  console.error(`Batch ${batchIndex + 1} fetched ${newItems.length} raw items.`);

  const normalizedNew = newItems
    .map(normalizeDeal)
    .filter((d) => d.discountPercent !== null && d.discountPercent >= MIN_DISCOUNT);

  console.error(`Batch ${batchIndex + 1} produced ${normalizedNew.length} qualifying deals.`);

  // Verify prices for top suspicious deals (80%+)
  const suspiciousDeals = normalizedNew.filter(d => d.needsReview).slice(0, 5);
  for (const deal of suspiciousDeals) {
    try {
      const realPrice = await scrapeRealPrice(deal.asin);
      if (realPrice !== null && deal.apiPrice) {
        const priceDiff = Math.abs(realPrice - deal.apiPrice) / deal.apiPrice;
        if (priceDiff > 0.10) {
          console.error(`Price mismatch for ${deal.asin}: API=$${deal.apiPrice}, Real=$${realPrice}`);
          deal.price = `$${realPrice.toFixed(2)}`;
          // Recalculate discount
          if (deal.originalPrice) {
            const origPrice = parseFloat(deal.originalPrice.replace('$', ''));
            if (origPrice > 0) {
              const newDiscount = Math.round(((origPrice - realPrice) / origPrice) * 100);
              deal.discountPercent = newDiscount;
              // If still high discount after real price check, keep flagged
              deal.needsReview = newDiscount >= SUSPICIOUS_DISCOUNT;
              deal.flagReason = deal.needsReview 
                ? `High discount (${newDiscount}%) verified - please confirm`
                : null;
            }
          }
        } else {
          // Price matches - it's a real deal!
          deal.needsReview = false;
          deal.flagReason = null;
          console.error(`Price verified for ${deal.asin}: Real deal at $${realPrice}`);
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.error(`Price verification error: ${err.message}`);
    }
  }

  // Load existing deals
  let existingDeals = [];
  try {
    const existing = await store.get("latest", { type: "json" });
    if (existing && Array.isArray(existing.deals)) {
      existingDeals = existing.deals;
    }
  } catch { }

  const now = Date.now();
  const maxAgeCutoff = now - MAX_AGE_HOURS * 60 * 60 * 1000;

 const freshExisting = existingDeals.filter((d) => {
    // Remove if expiry date passed
    if (d.expiresOn && new Date(d.expiresOn).getTime() < now) return false;
    // Remove if older than 7 days
    if (d.fetchedAt && new Date(d.fetchedAt).getTime() < maxAgeCutoff) return false;
   return true;
  });

  // Merge: update existing deals with fresh prices
  const merged = [...freshExisting];
  for (const deal of normalizedNew) {
    const idx = merged.findIndex((d) => d.asin === deal.asin);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...deal };
    } else {
      merged.push(deal);
    }
  }

  // Remove deals that dropped below minimum discount
  const validDeals = merged.filter((d) =>
    d.discountPercent !== null && d.discountPercent >= MIN_DISCOUNT
  );

  const deals = validDeals
    .sort((a, b) => (b.discountPercent || 0) - (a.discountPercent || 0))
    .slice(0, MAX_RESULTS);

  const output = {
    generatedAt: new Date().toISOString(),
    marketplace: MARKETPLACE,
    minDiscountPercent: MIN_DISCOUNT,
    deals,
    debug: {
      lastBatchIndex: batchIndex,
      lastBatchCategories: batch,
      lastBatchRawItems: newItems.length,
      lastBatchQualifyingDeals: normalizedNew.length,
      totalAccumulatedDeals: deals.length,
      suspiciousFlagged: suspiciousDeals.length,
    },
  };

  await store.setJSON("latest", output);
  await store.setJSON("batch-state", { nextBatchIndex });

  return output;
}

export default async (req) => {
  try {
    const result = await fetchAndStoreDeals();
    return new Response(
      JSON.stringify({ ok: true, count: result.deals.length, debug: result.debug }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("fetch-deals function failed:", err.message);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config = {
  schedule: "0 * * * *",
};
