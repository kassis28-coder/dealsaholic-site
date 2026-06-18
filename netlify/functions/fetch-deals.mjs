/**
 * Netlify Scheduled Function — runs automatically once a day.
 * This is the same logic as the standalone fetch-deals.js script,
 * adapted to run inside Netlify's serverless environment and write
 * its output to a location the live site can read from.
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
 *   DEALS_MAX_RESULTS    (default 24)
 */

import { getStore } from "@netlify/blobs";

const CLIENT_ID = process.env.AMAZON_CLIENT_ID;
const CLIENT_SECRET = process.env.AMAZON_CLIENT_SECRET;
const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG;
const MARKETPLACE = process.env.AMAZON_MARKETPLACE || "www.amazon.com";
const MIN_DISCOUNT = Number(process.env.DEALS_MIN_DISCOUNT || 20);
const MAX_RESULTS = Number(process.env.DEALS_MAX_RESULTS || 24);

const TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATALOG_URL = "https://creatorsapi.amazon/catalog/v1/searchItems";

const SEARCH_BUCKETS = [
  "deal of the day",
  "clearance",
  "electronics",
  "home and kitchen",
  "best sellers",
];

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
        "offersV2.listings.dealDetails",
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
  const savingsPercent = listing.dealDetails?.percentageOff;
  if (typeof savingsPercent === "number") return savingsPercent;
  const price = listing.price?.amount;
  const savingsAmount = listing.dealDetails?.savingsAmount?.amount;
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
    price: listing?.price?.displayAmount || null,
    discountPercent: computeDiscountPercent(item),
    rating: item.customerReviews?.starRating?.value || null,
    reviewCount: item.customerReviews?.count || null,
    url: item.detailPageURL || `https://www.amazon.com/dp/${item.asin}?tag=${PARTNER_TAG}`,
  };
}

async function fetchAndStoreDeals() {
  const accessToken = await getAccessToken();
