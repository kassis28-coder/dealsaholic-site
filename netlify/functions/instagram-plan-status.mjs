import { getStore } from "@netlify/blobs";
import { easternNow, publicSlot } from "./instagram-plan-utils.mjs";

export default async function handler(req) {
  const request = new URL(req.url);
  const date = request.searchParams.get("date") || easternNow().date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "Invalid date" }, { status: 400 });

  const plan = await getStore("instagram-daily-plan").get(`plan-${date}`, { type: "json" }).catch(() => null);
  if (!plan) return Response.json({ date, status: "no_plan" }, { status: 404 });

  // Deliberately omit captions, LinkDM draft codes, access tokens, and any
  // secret material. This endpoint is safe to use as a public diagnostic.
  return Response.json({
    date: plan.date,
    status: plan.status,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
    slots: Object.fromEntries(Object.entries(plan.slots || {}).map(([hour, slot]) => [hour, publicSlot(slot)])),
  });
}

export const config = { path: "/api/instagram-plan-status" };
