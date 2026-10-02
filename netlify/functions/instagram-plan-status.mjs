import { getStore } from "@netlify/blobs";

const TIME_ZONE = "America/New_York";

function todayKey() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const date = url.searchParams.get("date") || todayKey();
  const plan = await getStore("instagram-daily-plan").get(`plan-${date}`, { type: "json" }).catch(() => null);
  if (!plan) return Response.json({ date, status: "no_plan" }, { status: 404 });
  return Response.json(plan);
}

export const config = { path: "/api/instagram-plan-status" };
