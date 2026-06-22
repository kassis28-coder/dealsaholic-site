import { getStore } from "@netlify/blobs";

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
      data.deals = data.deals.filter(d => d.asin !== asin);
    } else if (action === "approve") {
      const idx = data.deals.findIndex(d => d.asin === asin);
      if (idx >= 0) {
        data.deals[idx].needsReview = false;
        data.deals[idx].flagReason = null;
        if (price) data.deals[idx].price = price;
        if (discountPercent) data.deals[idx].discountPercent = discountPercent;
      }
    } else if (action === "update") {
      const idx = data.deals.findIndex(d => d.asin === asin);
      if (idx >= 0) {
        if (price) data.deals[idx].price = price;
        if (discountPercent) data.deals[idx].discountPercent = discountPercent;
        data.deals[idx].needsReview = false;
        data.deals[idx].flagReason = null;
      }
    }

    await store.setJSON("latest", data);

    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: "/api/update-amazon-deal" };
