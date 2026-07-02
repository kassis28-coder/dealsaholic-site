mport { getStore } from "@netlify/blobs";

const ACCOUNT_SID = process.env.IMPACT_ACCOUNT_SID;
const AUTH_TOKEN = process.env.IMPACT_AUTH_TOKEN;

function addWalmartAffiliate(url) {
        if (!url) return url;
        if (url.includes("wmlspartner=")) return url;
        const sep = url.includes("?") ? "&" : "?";
        return `${url}${sep}wmlspartner=iplc1788825`;
}

async function fetchWalmartFromImpact() {
        const deals = [];
        try {
                  const auth = Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
                  const headers = { Authorization: `Basic ${auth}`, Accept: "application/json" };

          // Try Deals endpoint first
          let res = await fetch(`https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Campaigns/3940/Deals?PageSize=50`, { headers });
                  console.log("Deals endpoint status:", res.status);

          // If Deals fails try Items
          if (!res.ok) {
                      res = await fetch(`https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Campaigns/3940/Items?PageSize=50`, { headers });
                      console.log("Items endpoint status:", res.status);
          }

          if (!res.ok) {
                      const text = await res.text();
                      console.log("API error response:", text.substring(0, 500));
                      return deals;
          }

          const data = await res.json();
                  console.log("API response keys:", Object.keys(data).join(", "));

          const items = data?.Deals || data?.deals || data?.Items || data?.items || data?.Products || data?.products || [];
                  console.log(`Processing ${items.length} items`);

          for (const item of items) {
                      const id = item?.Id || item?.DealId || item?.CatalogItemId || item?.ItemId;
                      const name = item?.Name || item?.Title || item?.Description;
                      const price = item?.SalePrice || item?.Price || item?.CurrentPrice;
                      const wasPrice = item?.OriginalPrice || item?.WasPrice || item?.RegularPrice;
                      const image = item?.ImageUrl || item?.Image || item?.ThumbnailUrl;
                      const url = item?.TrackingLink || item?.Url || item?.ProductUrl || item?.Link;

                    if (!id || !name) continue;

                    const dealUrl = url || addWalmartAffiliate("https://www.walmart.com");

                    let discount = 0;
                      if (wasPrice && price && parseFloat(wasPrice) > parseFloat(price)) {
                                    discount = Math.round(((parseFloat(wasPrice) - parseFloat(price)) / parseFloat(wasPrice)) * 100);
                      }

                    const blocked = ["adult", "sex", "xxx", "erotic"];
                      if (blocked.some((w) => name.toLowerCase().includes(w))) continue;

                    deals.push({
                                  id: `walmart-impact-${id}`,
                                  title: name,
                                  price: price ? `$${parseFloat(price).toFixed(2)}` : null,
                                  originalPrice: wasPrice ? `$${parseFloat(wasPrice).toFixed(2)}` : null,
                                  discountPercent: discount || null,
                                  url: dealUrl,
                                  image: image || null,
                                  store: "walmart",
                                  status: "approved",
                                  sponsored: false,
                                  source: "impact-api",
                                  createdAt: new Date().toISOString(),
                                  expiresOn: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
                    });
          }
        } catch (e) {
                  console.log("Impact API error:", e.message);
        }
        return deals;
}

async function run() {
        if (!ACCOUNT_SID || !AUTH_TOKEN) throw new Error("Missing Impact credentials");
        const store = getStore("submissions");
        const { blobs } = await store.list();
        const existingIds = new Set(blobs.map((b) => b.key));
        const deals = await fetchWalmartFromImpact();
        console.log(`Found ${deals.length} Walmart deals`);
        let added = 0;
        for (const deal of deals) {
                  if (existingIds.has(deal.id)) continue;
                  await store.set(deal.id, JSON.stringify(deal));
                  added++;
                  console.log(`Added: ${deal.title}`);
        }
        return { success: true, added, total: deals.length };
}

export default async function handler(req) {
        if (req && req.url) {
                  const url = new URL(req.url);
                  const password = url.searchParams.get("password");
                  if (!password || password !== process.env.ADMIN_PASSWORD) {
                              return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
                  }
                  try {
                              const result = await run();
                              return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
                  } catch (err) {
                              return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
                  }
        }
        try { await run(); } catch (err) { console.error("Scheduled error:", err); }
}

export const config = { schedule: "0 */3 * * *" };
