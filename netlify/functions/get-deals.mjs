import { getStore } from "@netlify/blobs";

async function getApprovedSellerDeals() {
  try {
    const store = getStore("submissions");
    const index = await store.get("index", { type: "json" });
    if (!Array.isArray(index)) return [];
    const now = Date.now();
    const approved = [];
    for (const id of index) {
      let record;
      try {
        record = await store.get(id, { type: "json" });
      } catch { continue; }
      if (!record || record.status !== "approved") continue;
      const expiresAt = new Date(record.expiresOn).getTime();
      if (!isNaN(expiresAt) && expiresAt < now) continue;
      approved.push({
        id: record.id,
        asin: record.id,
        title: record.productTitle || record.title,
        image: record.image || record.photoUrl || record.imageUrl || null,
        price: record.price,
        originalPrice: record.originalPrice || null,
        discountPercent: record.discountPercent || (record.discount ? parseInt(record.discount) : null),
        rating: null,
        reviewCount: null,
        url: record.productUrl || record.url,
        discountCode: record.discountCode || null,
        sponsored: record.sponsored || false,
        source: record.source || 'seller',
        storeType: record.storeType || record.store || 'amazon',
        createdAt: record.createdAt || null,
      });
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

    const combined = {
      ...base,
      generatedAt: new Date().toISOString(),
      deals: allDeals,
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
