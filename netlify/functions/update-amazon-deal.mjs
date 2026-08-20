import { getStore } from "@netlify/blobs";

async function clearLegacyFlags(asin) {
  const flagStore = getStore("flagged-deals");
  const listing = await flagStore.list().catch(() => ({ blobs: [] }));
  const normalizedAsin = String(asin || "").toUpperCase();

  await Promise.all((listing.blobs || []).map(async (blob) => {
    const flag = await flagStore.get(blob.key, { type: "json" }).catch(() => null);
    const flagId = String(flag?.asin || flag?.dealId || "").toUpperCase();
    if (flagId === normalizedAsin) {
      await flagStore.delete(blob.key).catch(() => {});
    }
  }));
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { password, asin, action, price, discountPercent } = await req.json();

    if (password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const store = getStore("deals");
    const data = await store.get("latest", { type: "json" });

    if (!data || !Array.isArray(data.deals)) {
      return new Response(JSON.stringify({ error: "No deals found" }), { status: 404 });
    }

    if (action === "delete") {
      data.deals = data.deals.filter((deal) => deal.asin !== asin && deal.id !== asin);
    } else if (action === "approve" || action === "update") {
      const index = data.deals.findIndex((deal) => deal.asin === asin || deal.id === asin);
      if (index >= 0) {
        if (price) data.deals[index].price = price;
        if (discountPercent) data.deals[index].discountPercent = discountPercent;
        data.deals[index].needsReview = false;
        data.deals[index].flagReason = null;
        data.deals[index].flaggedAt = null;
        data.deals[index].flagIssueType = null;
      }
    }

    await store.setJSON("latest", data);
    await clearLegacyFlags(asin);
    await getStore("public-deals-cache").delete("latest-deduped-v2").catch(() => {});

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: "/api/update-amazon-deal" };
