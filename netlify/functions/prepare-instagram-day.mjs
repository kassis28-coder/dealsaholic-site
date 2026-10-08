import { getStore } from "@netlify/blobs";
import { renderInstagramCard } from "./instagram-card-renderer.mjs";
import { fetchPublishedInstagramDealIds } from "./instagram-dedupe.mjs";
import {
  SLOT_HOURS,
  SLOT_HOURS_EVENING_BATCH,
  SLOT_HOURS_NOON_BATCH,
  TIME_ZONE,
  addEasternDays,
  dealId,
  dealTimestamp,
  easternNow,
  isUsableDeal,
  productKey,
  slotSnapshot,
} from "./instagram-plan-utils.mjs";

function scheduledAt(date, hour) {
  return `${date}T${hour}:00:00[${TIME_ZONE}]`;
}

export function selectDeals(deals, excludedIds = new Set(), limit = SLOT_HOURS.length) {
  const unique = new Map();
  for (const deal of deals.filter(isUsableDeal)) {
    const id = dealId(deal);
    if (!excludedIds.has(id) && !unique.has(id)) unique.set(id, deal);
  }
  return [...unique.values()]
    .sort((a, b) => (Number(b.discountPercent) || 0) - (Number(a.discountPercent) || 0) || dealTimestamp(b) - dealTimestamp(a))
    .slice(0, limit);
}

export async function prepareInstagramBatch(req, { batch = "noon" } = {}) {
  const now = easternNow();
  const request = new URL(req.url);
  const manual = request.searchParams.get("manual") === "1";
  const planningHour = batch === "evening" ? "18" : "12";
  const batchHours = batch === "evening" ? SLOT_HOURS_EVENING_BATCH : SLOT_HOURS_NOON_BATCH;
  const inPlanningWindow = now.hour === planningHour && Number(now.minute) < 15;
  if (!manual && !inPlanningWindow) return Response.json({ skipped: `outside ${planningHour}:00 ET planning window`, now });

  const targetDate = request.searchParams.get("date") || addEasternDays(now.date, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return Response.json({ error: "Invalid target date" }, { status: 400 });

  const planStore = getStore("instagram-daily-plan");
  const planKey = `plan-${targetDate}`;
  const existing = await planStore.get(planKey, { type: "json" }).catch(() => null);
  const slots = { ...(existing?.slots || {}) };
  const missingBatchHours = batchHours.filter((hour) => !slots[hour]);
  if (!missingBatchHours.length) return Response.json({ ok: true, reused: true, date: targetDate, status: existing?.status, slots: batchHours });
  const priorHours = new Set(Object.keys(slots));

  const latest = await getStore("deals").get("latest", { type: "json" }).catch(() => null);
  const feedDeals = Array.isArray(latest?.deals) ? latest.deals : [];
  const instagramToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  let publishedDealIds;
  try {
    publishedDealIds = await fetchPublishedInstagramDealIds(instagramToken);
  } catch (error) {
    return Response.json({ error: "Instagram duplicate check failed; no plan was created", detail: error.message }, { status: 502 });
  }
  const historyStore = getStore("instagram-deal-history");
  const creativeStore = getStore("instagram-creatives");
  const approvalStore = getStore("instagram-approved-creative-queue");
  const approvalIndex = await approvalStore.get("approved-index", { type: "json" }).catch(() => null);
  const approvals = new Map((Array.isArray(approvalIndex?.items) ? approvalIndex.items : [])
    .filter((item) => item.status === "approved" && item.style_version === "luxury-lifestyle-editorial-v1")
    .map((item) => [String(item.deal_id), item]));
  // Approved creatives take priority even when their matching deal is not in
  // the first page of a large feed. Non-approved deals remain in the scan only
  // for backward compatibility with feed-provided approved image URLs.
  const candidates = selectDeals(feedDeals, publishedDealIds, feedDeals.length)
    .sort((a, b) => Number(approvals.has(dealId(b))) - Number(approvals.has(dealId(a))));
  const failures = [];

  // Only deals never reserved or published by this Instagram workflow qualify.
  // Generate, decode, dimension-check, and store every creative before a slot
  // enters the daily schedule. Bad remote images are skipped, not scheduled.
  for (const deal of candidates) {
    if (!missingBatchHours.length) break;
    const id = dealId(deal);
    const key = productKey(deal);
    const [priorDeal, priorProduct] = await Promise.all([
      historyStore.get(`deal-${encodeURIComponent(id)}`, { type: "json" }).catch(() => null),
      historyStore.get(`product-${encodeURIComponent(key)}`, { type: "json" }).catch(() => null),
    ]);
    if (priorDeal || priorProduct) continue;
    const hour = missingBatchHours[0];
    const slot = slotSnapshot(deal, hour, scheduledAt(targetDate, hour));
    try {
      const approval = approvals.get(id);
      let creative;
      if (approval) {
        const buffer = await approvalStore.get(approval.blob_key, { type: "arrayBuffer" });
        if (!buffer) throw new Error("Approved creative bytes are unavailable");
        creative = await renderInstagramCard(slot, { approvedBuffer: Buffer.from(buffer) });
      } else {
        creative = await renderInstagramCard(slot);
      }
      if (!creative.styleApproved || creative.styleVersion !== "luxury-lifestyle-editorial-v1") {
        throw new Error("Creative rejected: it does not match the locked Dress / Neutral Amazon Finds editorial style");
      }
      const creativeKey = `${targetDate}/${hour}-${encodeURIComponent(id)}-${creative.sha256.slice(0, 12)}.jpg`;
      await creativeStore.set(creativeKey, creative.buffer, { metadata: { contentType: creative.contentType, width: creative.width, height: creative.height, sha256: creative.sha256 } });
      slot.creative_key = creativeKey;
      slot.creative_status = "validated";
      slot.creative_width = creative.width;
      slot.creative_height = creative.height;
      slot.creative_bytes = creative.bytes;
      slot.creative_sha256 = creative.sha256;
      slot.creative_style_version = creative.styleVersion;
      slots[hour] = slot;
      missingBatchHours.shift();
    } catch (error) {
      failures.push({ deal_id: id, error: error.message });
    }
  }

  if (missingBatchHours.length) {
    return Response.json({ error: "Not enough unique deals with successfully validated Instagram creatives", validated: batchHours.length - missingBatchHours.length, failed_creatives: failures }, { status: 409 });
  }

  const createdAt = new Date().toISOString();
  const plan = { ...existing, date: targetDate, created_at: existing?.created_at || createdAt, updated_at: createdAt, status: Object.keys(slots).length === SLOT_HOURS.length ? "ready" : "partial", slots };
  await Promise.all(Object.values(slots).filter((slot) => !priorHours.has(slot.hour)).flatMap((slot) => {
    const record = {
      deal_id: slot.deal_id, product_key: slot.product_key, status: "reserved",
      plan_date: targetDate, hour: slot.hour, reserved_at: createdAt,
    };
    return [
      historyStore.setJSON(`deal-${encodeURIComponent(slot.deal_id)}`, record),
      historyStore.setJSON(`product-${encodeURIComponent(slot.product_key)}`, record),
    ];
  }));
  await planStore.setJSON(planKey, plan);
  const used = new Set(Object.values(slots).map((slot) => slot.deal_id));
  if (Array.isArray(approvalIndex?.items)) {
    approvalIndex.items = approvalIndex.items.map((item) => used.has(String(item.deal_id))
      ? { ...item, status: "reserved", plan_date: targetDate, reserved_at: createdAt }
      : item);
    approvalIndex.updated_at = createdAt;
    await approvalStore.setJSON("approved-index", approvalIndex);
  }
  console.log("[prepare-instagram-day]", JSON.stringify({ date: targetDate, batch, validated: batchHours.length, totalSlots: Object.keys(slots).length, failedCreativeCount: failures.length }));
  return Response.json({ ok: true, date: targetDate, batch, status: plan.status, slots: batchHours, creatives_validated: batchHours.length, total_slots: Object.keys(slots).length, failed_creatives: failures.length });
}

export default function handler(req) {
  return prepareInstagramBatch(req, { batch: "evening" });
}

export const config = { schedule: "*/5 * * * *" };
