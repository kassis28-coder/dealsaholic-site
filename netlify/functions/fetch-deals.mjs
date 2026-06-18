/**
 * Netlify Scheduled Function — runs automatically every hour.
 * Each run only searches a SLICE of categories (one "batch") instead
 * of all 28 at once. This avoids Amazon's rate limit (which was
 * causing 429 ThrottleException errors when all 28 ran back-to-back)
 * and avoids Netlify's function timeout.
 *
 * Results from each batch are MERGED into the existing stored deals
 * rather than replacing them, so the full catalog builds up over a
 * full rotation (4 batches × every hour = full refresh every 4 hours).
 * Deals older than 24 hours are dropped so prices don't go stale.
 *
 * Schedule is configured in netlify.toml, not here.
 *
 * Required environment variables (set in Netlify dashboard under
 * Site configuration → Environment variables):
 *   AMAZON_CLIENT_ID
 *   AMAZON_CLIENT_SECRET
 *   AMAZON_PARTNER_TAG
 *
 * Optional:
 *   AMAZON_MARKETPLACE   (default "www.amazon.com")
 *   DEALS_MIN_DISCOUNT   (default 20)
 *   DEALS_MAX_RESULTS    (default 300)
 */

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

// Split the 28 categories into 4 batches of 7. Each scheduled run
// only processes one batch, then moves to the next on the following run.
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

  // Figure out which batch to run this time. We store the index of
  // the NEXT batch to run, so each invocation advances the rotation.
  let batchIndex = 0;
  try {
    const stateResult = await store.get("batch-state", { type: "json" });
    if (stateResult && typeof stateResult.nextBatchIndex === "number") {
      batchIndex = stateResult.nextBatchIndex;
    }
  } catch {
    // No state yet — start at batch 0.
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

  console.error(`Batch ${batchIndex + 1} produced ${normalizedNew.length} qualifying deals (>= ${MIN_DISCOUNT}% off).`);

  // Load existing accumulated deals so we can merge instead of overwrite.
  let existingDeals = [];
  try {
    const existing = await store.get("latest", { type: "json" });
    if (existing && Array.isArray(existing.deals)) {
      existingDeals = existing.deals;
    }
  } catch {
    // No existing data yet — that's fine on first run.
  }

  // Drop anything older than MAX_AGE_HOURS so stale prices fall off.
  const cutoff = Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000;
  const freshExisting = existingDeals.filter((d) => {
    if (!d.fetchedAt) return true; // keep older records that predate this field
    return new Date(d.fetchedAt).getTime() >= cutoff;
  });

  // Merge: new deals replace existing entries with the same ASIN
  // (price/discount refreshed), everything else stays as-is.
  const merged = [...freshExisting];
  for (const deal of normalizedNew) {
    const idx = merged.findIndex((d) => d.asin === deal.asin);
    if (idx >= 0) {
      merged[idx] = deal;
    } else {
      merged.push(deal);
    }
  }

  const deals = merged
    .sort((a, b) => b.discountPercent - a.discountPercent)
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
