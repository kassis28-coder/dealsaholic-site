import { getStore } from "@netlify/blobs";

const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const MIN_DISCOUNT = Number(process.env.DEALS_MIN_DISCOUNT || 20);
const MAX_RESULTS = Number(process.env.DEALS_MAX_RESULTS || 300);
const MAX_AGE_HOURS = 24;

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

const ALL_CATEGORIES = [
  "deal of the day",
  "clearance",
  "today's deals",
  "electronics",
  "electronics accessories",
  "headphones",
  "home and kitchen",
  "kitchen gadgets",
  "small appliances",
  "best sellers",
  "home decor",
  "wall art",
  "furniture",
  "storage organization",
  "bathroom accessories",
  "bedroom furniture",
  "bedding sheets",
  "pillows comforters",
  "kitchen appliances deals",
  "living room furniture",
  "home improvement",
  "curtains blinds",
  "beauty",
  "skincare",
  "haircare tools",
  "toys",
  "toys for kids",
  "board games",
  "fashion",
  "womens clothing",
  "mens clothing",
  "shoes",
  "sports and outdoors",
  "fitness equipment",
  "outdoor camping gear",
  "pet supplies",
  "toilet paper",
  "paper towels",
  "laundry detergent",
  "dish soap",
  "cleaning supplies",
  "trash bags",
  "household essentials",
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
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }
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
    console.error(`searchItems("${keywords}") failed (${res.status}): ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return data.items || data.searchResult?.items || [];
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
  return {
    asin: item.asin,
    title: item.itemInfo?.title?.displayValue || "Untitled product",
    image: item.images?.primary?.large?.url || null,
    price: listing?.price?.money?.displayAmount || null,
    discountPercent: computeDiscountPercent(item),
    rating: item.customerReviews?.starRating?.value || null,
    reviewCount: item.customerReviews?.count || null,
    url: item.detailPageURL || `https://www.amazon.com/dp/${item.asin}?tag=${PARTNER_TAG}`,
    fetchedAt: new Date().toISOString(),
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
  } catch {
    // No state yet
  }

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

  // Load existing deals
  let existingDeals = [];
  try {
    const existing = await store.get("latest", { type: "json" });
    if (existing && Array.isArray(existing.deals)) {
      existingDeals = existing.deals;
    }
  } catch {
    // No existing data yet
  }

  const now = Date.now();
  const maxAgeCutoff = now - MAX_AGE_HOURS * 60 * 60 * 1000;

  // Remove deals older than 24 hours
  const freshExisting = existingDeals.filter((d) => {
    if (!d.fetchedAt) return true;
    return new Date(d.fetchedAt).getTime() >= maxAgeCutoff;
  });

  // Merge: update existing deals with fresh prices
  const merged = [...freshExisting];
  for (const deal of normalizedNew) {
    const idx = merged.findIndex((d) => d.asin === deal.asin);
    if (idx >= 0) {
      // Update with fresh price and data
      merged[idx] = { ...merged[idx], ...deal };
    } else {
      merged.push(deal);
    }
  }

  // Remove deals that dropped below minimum discount after price update
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
