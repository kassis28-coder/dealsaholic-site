import { getStore } from "@netlify/blobs";

function normalizeId(value) {
  return String(value || "").trim().toUpperCase();
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { password } = await req.json();
    if (password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const dealsStore = getStore("deals");
    const data = await dealsStore.get("latest", { type: "json" }).catch(() => null);
    const deals = Array.isArray(data?.deals) ? data.deals : [];
    const flaggedDeals = deals.filter((deal) => deal.needsReview === true);
    const seen = new Set(flaggedDeals.map((deal) => normalizeId(deal.asin || deal.id)));

    // Include reports created by the older endpoint and reports saved while an
    // Amazon refresh was replacing the source record.
    const flagStore = getStore("flagged-deals");
    const listing = await flagStore.list().catch(() => ({ blobs: [] }));
    for (const blob of listing.blobs || []) {
      const flag = await flagStore.get(blob.key, { type: "json" }).catch(() => null);
      if (!flag) continue;

      const id = normalizeId(flag.asin || flag.dealId);
      if (seen.has(id)) continue;
      const matchingDeal = deals.find((deal) =>
        normalizeId(deal.asin || deal.id) === id
          || String(deal.url || "") === String(flag.productUrl || flag.url || "")
      );

      flaggedDeals.push({
        ...(matchingDeal || {}),
        ...flag,
        asin: matchingDeal?.asin || flag.asin || flag.dealId,
        title: matchingDeal?.title || flag.title || `Reported Amazon deal ${flag.dealId}`,
        image: matchingDeal?.image || flag.image || null,
        price: matchingDeal?.price || flag.price || null,
        originalPrice: matchingDeal?.originalPrice || flag.originalPrice || null,
        discountPercent: matchingDeal?.discountPercent || flag.discountPercent || null,
        url: matchingDeal?.url || flag.productUrl || flag.url,
        needsReview: true,
      });
      seen.add(id);
    }

    flaggedDeals.sort((a, b) =>
      new Date(b.flaggedAt || 0).getTime() - new Date(a.flaggedAt || 0).getTime()
    );

    return new Response(JSON.stringify({ flaggedDeals }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: "/api/get-flagged-deals" };
