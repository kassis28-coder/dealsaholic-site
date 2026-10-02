import { getStore } from "@netlify/blobs";

function authorized(req) {
  const secret = process.env.SOCIAL_AUTOMATION_SECRET;
  if (!secret) return false;
  const supplied = req.headers.get("x-social-automation-secret") || "";
  return supplied === secret;
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const date = String(body.date || "");
  const hour = String(body.hour || "").padStart(2, "0");
  const draftCode = String(body.draftCode || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(07|10|13|16|19|22)$/.test(hour) || !draftCode) {
    return Response.json({ error: "date, hour and draftCode are required" }, { status: 400 });
  }

  const store = getStore("instagram-daily-plan");
  const key = `plan-${date}`;
  const plan = await store.get(key, { type: "json" }).catch(() => null);
  if (!plan?.slots?.[hour]) return Response.json({ error: "planned slot not found" }, { status: 404 });

  plan.slots[hour].linkdmDraftCode = draftCode;
  plan.slots[hour].linkdmStatus = "ready";
  plan.updatedAt = new Date().toISOString();
  plan.status = Object.values(plan.slots).every((s) => s.linkdmDraftCode) ? "ready" : "waiting_for_linkdm";
  await store.setJSON(key, plan);
  return Response.json({ ok: true, date, hour, status: plan.status });
}
