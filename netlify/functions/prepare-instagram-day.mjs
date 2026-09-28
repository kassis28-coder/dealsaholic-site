import { getStore } from "@netlify/blobs";

const SITE_URL = "https://deals-aholic.com";
const TIME_ZONE = "America/New_York";
const SLOT_HOURS = ["07", "10", "13", "16", "19", "22"];

function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

function dateKey(parts) {
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addEasternDays(key, days) {
  const [y,m,d] = key.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d + days, 17, 0, 0));
  return dateKey(easternParts(noon));
}

function keyFor(deal) {
  return String(deal?.id || deal?.asin || deal?.url || "");
}

function usable(deal) {
  const title = String(deal?.title || "").trim();
  const image = String(deal?.image || deal?.imageUrl || "").trim();
  const url = String(deal?.url || "").trim();
  return Boolean(!deal?.needsReview && title.length >= 8 && image && url && !/<(?:html|body|head)(?:\s|>)/i.test(title));
}

function ts(deal) {
  const value = new Date(deal?.createdAt || deal?.fetchedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function destinationUrl(deal) {
  const id = String(deal?.id || deal?.asin || "").trim();
  return id ? `${SITE_URL}/d/${encodeURIComponent(id)}` : String(deal?.url || SITE_URL);
}

function snapshot(deal, hour) {
  const key = keyFor(deal);
  return {
    hour,
    dealId: key,
    title: String(deal.title || "").trim(),
    price: deal.price || null,
    originalPrice: deal.originalPrice || null,
    promoCode: deal.promoCode || deal.discountCode || deal.code || null,
    sourceImageUrl: String(deal.image || deal.imageUrl || ""),
    destinationUrl: destinationUrl(deal),
    socialImageUrl: `${SITE_URL}/api/social-card?id=${encodeURIComponent(key)}&v=editorial-safe-4x5`,
    linkdmDraftCode: null,
    linkdmStatus: "waiting_for_draft",
    instagramStatus: "planned",
    instagramMediaId: null,
    retryCount: 0,
    lastError: null,
  };
}

export default async function handler(req) {
  const now = easternParts();
  const isScheduledWindow = now.hour === "18" && Number(now.minute) < 15;
  const url = new URL(req.url);
  const manual = url.searchParams.get("manual") === "1";
  if (!manual && !isScheduledWindow) {
    return Response.json({ skipped: "outside 6 PM ET planning window" });
  }

  const target = url.searchParams.get("date") || addEasternDays(dateKey(now), 1);
  const latest = await getStore("deals").get("latest", { type: "json" }).catch(() => null);
  const deals = Array.isArray(latest?.deals) ? [...latest.deals] : [];
  const selected = deals
    .filter(usable)
    .sort((a,b) => (Number(b.discountPercent)||0) - (Number(a.discountPercent)||0) || ts(b) - ts(a))
    .filter((deal, index, arr) => arr.findIndex((x) => keyFor(x) === keyFor(deal)) === index)
    .slice(0, SLOT_HOURS.length);

  if (selected.length < SLOT_HOURS.length) {
    return Response.json({ error: "Not enough eligible deals to prepare six posts", eligible: selected.length }, { status: 409 });
  }

  const plan = {
    date: target,
    createdAt: new Date().toISOString(),
    status: "waiting_for_linkdm",
    slots: Object.fromEntries(SLOT_HOURS.map((hour, i) => [hour, snapshot(selected[i], hour)])),
  };

  const store = getStore("instagram-daily-plan");
  await store.setJSON(`plan-${target}`, plan);
  return Response.json(plan);
}

export const config = { schedule: "*/15 * * * *" };
