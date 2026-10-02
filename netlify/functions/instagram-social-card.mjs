import { getStore } from "@netlify/blobs";
import { SLOT_HOURS } from "./instagram-plan-utils.mjs";

// Serve only the exact creative generated and validated during planning. The
// mutable deal feed and remote product image are never consulted at post time.
export default async function handler(req) {
  const requestUrl = new URL(req.url);
  const date = String(requestUrl.searchParams.get("date") || "");
  const hour = String(requestUrl.searchParams.get("hour") || "").padStart(2, "0");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !SLOT_HOURS.includes(hour)) return new Response("date and hour are required", { status: 400 });

  const plan = await getStore("instagram-daily-plan").get(`plan-${date}`, { type: "json" }).catch(() => null);
  const slot = plan?.slots?.[hour];
  if (!slot?.creative_key || slot?.creative_status !== "validated") return new Response("Validated Instagram creative is unavailable", { status: 404 });
  const creative = await getStore("instagram-creatives").get(slot.creative_key, { type: "arrayBuffer" }).catch(() => null);
  if (!creative?.byteLength) return new Response("Validated Instagram creative is unavailable", { status: 404 });
  return new Response(creative, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=604800, immutable",
      "Netlify-CDN-Cache-Control": "public, durable, max-age=604800, immutable",
    },
  });
}

export const config = { path: "/api/instagram-social-card" };
