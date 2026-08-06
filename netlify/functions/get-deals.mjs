import { getStore } from "@netlify/blobs";

const PUBLIC_FEED_CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_FEED_CACHE_KEY = "latest-after-review-restore";
const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=30",
  "Netlify-CDN-Cache-Control": "public, durable, max-age=300, stale-while-revalidate=86400",
};

// Titles that come from email auto-replies, bounces, or failed parsing.
const GARBAGE_TITLE_RE = /^(?:the response was|message not delivered|undelivered mail|auto.?reply|delivery status|mail delivery|failure notice|returned mail|amazon deal|no title|untitled)\b/i;

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

export default async () => {
  const publicCache = getStore("public-deals-cache");
  let cachedFeed = null;
  try {
    cachedFeed = await publicCache.get(PUBLIC_FEED_CACHE_KEY, { type: "json" }).catch(() => null);
    if (cachedFeed?.payload && Date.now() - cachedFeed.cachedAt < PUBLIC_FEED_CACHE_TTL_MS) {
      return new Response(JSON.stringify(cachedFeed.payload), { headers: RESPONSE_HEADERS });
    }

    const store = getStore("deals");
    const data = await store.get("latest", { type: "json" });
    const sellerDeals = await getApprovedSellerDeals();
    const base = data || {
      generatedAt: null,
      deals: [],
      message: "No deals fetched yet — first scheduled run hasn't completed.",
    };

    // Filter out flagged/suspicious Amazon deals from public view
    const amazonDeals = (base.deals || []).filter(d => !d.needsReview);

    // Combine all deals and sort newest first
    const allDeals = [...sellerDeals, ...amazonDeals];
    allDeals.sort((a, b) => new Date(b.createdAt || b.fetchedAt || 0) - new Date(a.createdAt || a.fetchedAt || 0));

    // Deduplicate by ASIN to prevent duplicate deals
    const seen = new Map();
    for (const deal of allDeals) {
      const key = deal.asin || deal.url;
      if (key && !seen.has(key)) seen.set(key, deal);
    }
    const deduped = Array.from(seen.values());

    const combined = {
      ...base,
      generatedAt: new Date().toISOString(),
      deals: deduped,
    };

    await publicCache.setJSON(PUBLIC_FEED_CACHE_KEY, {
      cachedAt: Date.now(),
      payload: combined,
    }).catch(err => console.log("Public feed cache write failed:", err.message));

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
