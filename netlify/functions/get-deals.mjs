import { getStore } from "@netlify/blobs";

// Rebuilding this feed requires reading more than 2,000 reviewed submissions.
// Keep the already-built feed warm long enough that normal visitors never pay
// that cold-build cost. New approvals still appear on the next refresh.
const PUBLIC_FEED_CACHE_TTL_MS = 30 * 60 * 1000;
const PUBLIC_FEED_CACHE_KEY = "latest-deduped-v2";
// Keep Amazon search inventory fresh; seller deals still use their own expiry dates.
const AMAZON_PUBLIC_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PUBLIC_AMAZON_DEALS = 120;
const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=30",
  "Netlify-CDN-Cache-Control": "public, durable, max-age=1800, stale-while-revalidate=86400",
};
const STALE_RESPONSE_HEADERS = {
  ...RESPONSE_HEADERS,
  // Check back soon after the background refresh, instead of caching the old
  // payload at the edge for another full 30 minutes.
  "Netlify-CDN-Cache-Control": "public, durable, max-age=60, stale-while-revalidate=86400",
};

// Titles that come from email auto-replies, bounces, or failed parsing.
const GARBAGE_TITLE_RE = /^(?:the response was|message not delivered|undelivered mail|auto.?reply|delivery status|mail delivery|failure notice|returned mail|amazon deal|no title|untitled)\b/i;
const GENERIC_DEAL_TITLES = new Set([
  "with deal",
  "price drop",
  "at checkout",
  "amazon deal",
  "limited time deal",
]);
const COMMON_COLORS_RE = /\b(?:black|white|gray|grey|red|blue|green|yellow|orange|purple|pink|brown|beige|tan|navy|teal|gold|silver|rose gold|multicolor|multi color|assorted|clear)\b/g;
const COMMON_SIZE_WORDS_RE = /\b(?:xxs|xs|small|medium|large|xl|xxl|xxxl|extra small|extra large|one size|os|twin|twin xl|full|queen|king|cal king|california king|standard|mini|compact|regular|short|long|wide|narrow)\b/g;

function normalizeAsin(value) {
  const asin = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : "";
}

function normalizeAmazonUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!/(^|\.)amazon\.com$/.test(host)) return "";
    const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i)?.[1];
    if (asin) return `amazon.com/dp/${asin.toUpperCase()}`;
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    return path ? `${host}${path}` : "";
  } catch {
    return "";
  }
}

function normalizeImage(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = decodeURIComponent(url.pathname)
      .replace(/\._[^/]+_(?=\.[a-z0-9]+$)/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    return path ? `${host}${path}` : "";
  } catch {
    return String(value).trim().toLowerCase().split(/[?#]/, 1)[0];
  }
}

function normalizeMeaningfulTitle(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(COMMON_COLORS_RE, " ")
    .replace(COMMON_SIZE_WORDS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || GENERIC_DEAL_TITLES.has(normalized)) return "";
  // Very short titles are too broad to safely merge across independent sellers.
  if (normalized.length < 8 || normalized.split(" ").length < 2) return "";
  return normalized;
}

function dealTimestamp(deal) {
  const timestamp = new Date(deal.createdAt || deal.fetchedAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function deduplicateDeals(candidates) {
  const sorted = [...candidates].sort((a, b) =>
    (Number(b.discountPercent) || 0) - (Number(a.discountPercent) || 0)
      || dealTimestamp(b) - dealTimestamp(a)
  );
  const seenAsins = new Set();
  const seenUrls = new Set();
  const seenImages = new Set();
  const seenTitles = new Set();
  const deduped = [];

  for (const deal of sorted) {
    const asin = normalizeAsin(deal.asin);
    const url = !asin ? normalizeAmazonUrl(deal.url) : "";
    const image = normalizeImage(deal.image);
    const title = normalizeMeaningfulTitle(deal.title);

    if (asin && seenAsins.has(asin)) continue;
    if (url && seenUrls.has(url)) continue;
    if (image && seenImages.has(image)) continue;
    if (title && seenTitles.has(title)) continue;

    if (asin) seenAsins.add(asin);
    if (url) seenUrls.add(url);
    if (image) seenImages.add(image);
    if (title) seenTitles.add(title);
    deduped.push(deal);
  }

  return deduped;
}

function isGarbageSubmission(record) {
  const title = (record.productTitle || record.title || '').trim();
  if (!title || title.length < 8) return true;
  if (GARBAGE_TITLE_RE.test(title)) return true;
  const url = record.productUrl || record.url || '';
  if (!url) return true;
  return false;
}

async function getApprovedSellerDeals() {
  try {
    const store = getStore("submissions");
    const index = await store.get("index", { type: "json" });
    if (!Array.isArray(index)) return [];

    // Cap at the 100 most recent IDs (index is newest-first)
    const recentIds = index; // no cap — show all approved non-expired deals
    const now = Date.now();

    // Fetch all records in parallel instead of sequentially
    // Blob reads are independent. Higher parallelism keeps the public API
    // responsive even when the submissions index contains thousands of deals.
    // Blob reads are independent. Larger batches substantially reduce cold-start
    // latency while keeping memory bounded for the current catalog size.
    const CONCURRENCY = 400;
    const approved = [];

    for (let i = 0; i < recentIds.length; i += CONCURRENCY) {
      const batch = recentIds.slice(i, i + CONCURRENCY);
      const records = await Promise.all(
        batch.map(id => store.get(id, { type: "json" }).catch(() => null))
      );

      for (const record of records) {
        if (!record || record.status !== "approved") continue;
        // The temporary replacement importer used `email-*` IDs and approved
        // them without an admin action. Keep those records off the public site
        // until the admin explicitly approves them (which sets reviewedAt).
        if (String(record.id || '').startsWith('email-')
            && record.source === 'email'
            && !record.reviewedAt) continue;
        if (isGarbageSubmission(record)) continue;
        const expiresAt = new Date(record.expiresOn).getTime();
        if (!isNaN(expiresAt) && expiresAt < now) continue;

        const storedUrl = record.productUrl || record.url || '';
        const urlAsin = storedUrl.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1] || null;
        const validAsin = (record.asin && /^[A-Z0-9]{10}$/i.test(record.asin))
          ? record.asin
          : urlAsin;

        approved.push({
          id: record.id,
          asin: validAsin || null,
          title: record.productTitle || record.title,
          image: record.image || record.photoUrl || record.imageUrl || null,
          price: record.price,
          originalPrice: record.originalPrice || null,
          discountPercent: record.discountPercent || (record.discount ? parseInt(record.discount) : null),
          rating: null,
          reviewCount: null,
          url: storedUrl,
          discountCode: record.discountCode || null,
          sponsored: record.sponsored || false,
          source: record.source || 'seller',
          storeType: record.storeType || record.store || 'amazon',
          createdAt: record.createdAt || null,
        });
      }
    }

    return approved;
  } catch {
    return [];
  }
}

async function rebuildPublicFeed(publicCache) {
    const store = getStore("deals");
    const data = await store.get("latest", { type: "json" });
    const sellerDeals = await getApprovedSellerDeals();
    const base = data || {
      generatedAt: null,
      deals: [],
      message: "No deals fetched yet — first scheduled run hasn't completed.",
    };

    // Filter out flagged/suspicious Amazon deals from public view
    const amazonCutoff = Date.now() - AMAZON_PUBLIC_WINDOW_MS;
    const amazonDeals = (base.deals || [])
      .filter(d => !d.needsReview)
      .filter(d => {
        const fetchedAt = new Date(d.fetchedAt || 0).getTime();
        return Number.isFinite(fetchedAt) && fetchedAt >= amazonCutoff;
      })
      .sort((a, b) => new Date(b.fetchedAt || 0) - new Date(a.fetchedAt || 0))
      .slice(0, MAX_PUBLIC_AMAZON_DEALS);

    // Keep the strongest version of a product. Amazon variations can have
    // different ASINs, so also compare canonical images and meaningful titles.
    const allDeals = [...sellerDeals, ...amazonDeals];
    const deduped = deduplicateDeals(allDeals);

    const combined = {
      ...base,
      generatedAt: new Date().toISOString(),
      deals: deduped,
    };

    await publicCache.setJSON(PUBLIC_FEED_CACHE_KEY, {
      cachedAt: Date.now(),
      payload: combined,
    }).catch(err => console.log("Public feed cache write failed:", err.message));

    return combined;
}

export default async (_req, context) => {
  const publicCache = getStore("public-deals-cache");
  let cachedFeed = null;
  try {
    cachedFeed = await publicCache.get(PUBLIC_FEED_CACHE_KEY, { type: "json" }).catch(() => null);
    if (cachedFeed?.payload) {
      const cacheAge = Date.now() - cachedFeed.cachedAt;
      if (cacheAge >= PUBLIC_FEED_CACHE_TTL_MS && context?.waitUntil) {
        // Return the last good feed immediately. Netlify keeps this invocation
        // alive only for the refresh, so visitors never wait for thousands of
        // Blob reads after a deploy or cache expiry.
        context.waitUntil(
          rebuildPublicFeed(publicCache).catch(err =>
            console.log("Background public feed refresh failed:", err.message)
          )
        );
      }
      return new Response(JSON.stringify(cachedFeed.payload), {
        headers: cacheAge >= PUBLIC_FEED_CACHE_TTL_MS ? STALE_RESPONSE_HEADERS : RESPONSE_HEADERS,
      });
    }

    const combined = await rebuildPublicFeed(publicCache);

    return new Response(JSON.stringify(combined), {
      headers: RESPONSE_HEADERS,
    });
  } catch (err) {
    if (cachedFeed?.payload) {
      return new Response(JSON.stringify(cachedFeed.payload), { headers: RESPONSE_HEADERS });
    }
    return new Response(
      JSON.stringify({ deals: [], error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
