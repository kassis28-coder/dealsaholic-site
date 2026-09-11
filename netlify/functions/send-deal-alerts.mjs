import { getStore } from "@netlify/blobs";

function categoryFor(deal) {
  const value = `${deal.title || ""} ${deal.storeType || ""}`.toLowerCase();
  if (/laptop|phone|tablet|headphone|tv |camera|computer|gaming|charger|bluetooth/.test(value)) return "electronics";
  if (/dress|shirt|jeans|shoe|sneaker|clothing|fashion|jacket/.test(value)) return "fashion";
  if (/makeup|skin|serum|shampoo|beauty|perfume|hair/.test(value)) return "beauty";
  if (/toy|lego|doll|game|puzzle/.test(value)) return "toys";
  if (/kitchen|air fryer|coffee|blender|cookware|home|storage|furniture/.test(value)) return "home";
  if (/pet|dog|cat/.test(value)) return "pets";
  if (/sport|fitness|camping|outdoor|gym/.test(value)) return "sports";
  return "other";
}

function matchingDeal(deals, alert) {
  const sent = new Set(alert.sentDealIds || []);
  return deals.find((deal) => {
    const id = String(deal.id || deal.asin || deal.url || "");
    if (!id || sent.has(id)) return false;
    const text = `${deal.title || ""} ${deal.storeType || ""}`.toLowerCase();
    return (alert.keywords || []).some((term) => text.includes(term)) || (alert.categories || []).includes('featured') || (alert.categories || []).includes(categoryFor(deal));
  });
}

export default async () => {
  const alertStore = getStore("deal-alerts");
  const dealStore = getStore("deals");
  const latest = await dealStore.get("latest", { type: "json" }).catch(() => null);
  const deals = (latest?.deals || []).filter((deal) => !deal.needsReview).slice(0, 250);
  if (!deals.length) return new Response(JSON.stringify({ sent: 0 }));
  const listed = await alertStore.list({ prefix: "alert-" });
  let sent = 0;
  for (const blob of listed.blobs || []) {
    const alert = await alertStore.get(blob.key, { type: "json" }).catch(() => null);
    if (!alert?.enabled || !alert.token) continue;
    const deal = matchingDeal(deals, alert);
    if (!deal) continue;
    const dealId = String(deal.id || deal.asin || deal.url);
    const body = `${deal.title || "A new deal"}${deal.price ? ` — ${deal.price}` : ""}`.slice(0, 180);
    try {
      const push = await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ to: alert.token, title: "New deal alert 🔥", body, sound: "default", data: { url: `dealsaholic://deal/${encodeURIComponent(dealId)}` } }) });
      if (!push.ok) continue;
      alert.sentDealIds = [dealId, ...(alert.sentDealIds || [])].slice(0, 200);
      alert.lastSentAt = new Date().toISOString();
      await alertStore.setJSON(blob.key, alert);
      sent += 1;
    } catch (error) { console.error("Alert push failed", error.message); }
  }
  return new Response(JSON.stringify({ sent }), { headers: { "Content-Type": "application/json" } });
};

export const config = { schedule: "5 * * * *" };
