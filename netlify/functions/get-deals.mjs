import { getStore } from "@netlify/blobs";

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
    const recentIds = index.slice(0, 100);
    const now = Date.now();

    // Fetch all records in parallel instead of sequentially
    const CONCURRENCY = 20;
    const approved = [];

    for (let i = 0; i < recentIds.length; i += CONCURRENCY) {
      const batch = recentIds.slice(i, i + CONCURRENCY);
      const records = await Promise.all(
        batch.map(id => store.get(id, { type: "json" }).catch(() => null))
      );

      for (const record of records) {
        if (!record || record.status !== "approved") continue;
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
  try {
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

    return new Response(JSON.stringify(combined), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ deals: [], error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
