import { getStore } from "@netlify/blobs";
import { SLOT_HOURS, buildCaption } from "./instagram-plan-utils.mjs";

function authorized(req) {
  const secret = process.env.SOCIAL_AUTOMATION_SECRET;
  if (!secret) return false;
  const supplied = req.headers.get("x-social-automation-secret") || "";
  // Keep the endpoint inaccessible without the environment secret. Do not
  // return the expected value or log supplied values.
  return supplied === secret;
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const date = String(body.date || "");
  const hour = String(body.hour || "").padStart(2, "0");
  const draftCode = String(body.draftCode || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !SLOT_HOURS.includes(hour) || !draftCode || draftCode.length > 500) {
    return Response.json({ error: "date, hour and draftCode are required" }, { status: 400 });
  }

  const store = getStore("instagram-daily-plan");
  const key = `plan-${date}`;
  const plan = await store.get(key, { type: "json" }).catch(() => null);
  const slot = plan?.slots?.[hour];
  if (!slot) return Response.json({ error: "planned slot not found" }, { status: 404 });
  if (slot.instagram_status === "published") {
    return Response.json({ error: "Instagram slot is already published; draft code cannot be changed" }, { status: 409 });
  }
  if (slot.instagram_container_id || ["creating_container", "manual_recovery_required"].includes(slot.instagram_status)) {
    return Response.json({ error: "Instagram media creation has started; its frozen caption cannot be changed" }, { status: 409 });
  }

  slot.linkdm_draft_code = draftCode;
  slot.linkdm_status = "ready";
  // The code must be the last line of the caption associated with this
  // frozen deal. Rebuild only from the slot snapshot; never consult latest
  // deals at this point.
  slot.caption = buildCaption(slot);
  slot.last_error = null;
  plan.updated_at = new Date().toISOString();
  plan.status = "ready";
  await store.setJSON(key, plan);
  return Response.json({ ok: true, date, hour, linkdm_status: slot.linkdm_status, plan_status: plan.status });
}
