import { getStore } from "@netlify/blobs";

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const { password } = await req.json();
    if (password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const store = getStore("deals");
    const data = await store.get("latest", { type: "json" });
    
    if (!data || !Array.isArray(data.deals)) {
      return new Response(JSON.stringify({ flaggedDeals: [] }), { status: 200 });
    }

    const flaggedDeals = data.deals.filter(d => d.needsReview === true);

    return new Response(JSON.stringify({ flaggedDeals }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: "/api/get-flagged-deals" };
