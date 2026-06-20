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
        asin: record.id,
        title: record.productTitle || record.title,
        image: record.photoUrl || record.imageUrl || null,
        price: record.price,
        discountPercent: record.discount ? parseInt(record.discount) : null,
        rating: null,
        reviewCount: null,
        url: record.productUrl || record.url,
        discountCode: record.discountCode || null,
        sponsored: record.sponsored || false,
        createdAt: record.createdAt || null,
      });
    }
    // Newest first
    approved.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
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
    const combined = {
      ...base,
      deals: [...sellerDeals, ...(base.deals || [])],
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
