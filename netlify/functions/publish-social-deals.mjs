import { getStore } from "@netlify/blobs";

const INSTAGRAM_GRAPH_API = "https://graph.instagram.com/v25.0";
const TIME_ZONE = "America/New_York";
const SLOT_HOURS = new Set(["07", "10", "13", "16", "19", "22"]);
const RETRY_WINDOW_MINUTES = 25;

function easternNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return { date: `${v.year}-${v.month}-${v.day}`, hour: v.hour, minute: Number(v.minute) };
}

function buildCaption(slot) {
  const lines = [
    "🔥 Deal drop!",
    slot.title,
    slot.price ? `💰 ${slot.price}${slot.originalPrice ? ` (was ${slot.originalPrice})` : ""}` : "",
    slot.promoCode ? `🏷️ Promo code: ${slot.promoCode}` : "",
    "",
    "Comment LINK and I’ll send you the exact deal in your DMs 💌",
    "",
    "Follow @deals_aholic for more daily finds, price drops, and promo codes.",
    "",
    "#ad As an Amazon Associate, Deals-Aholic may earn from qualifying purchases.",
    "#DealsAholic #AmazonFinds #DealAlert #ShoppingDeals #Sale",
    "",
    // LinkDM DM Planner draft code must remain in the caption so LinkDM can
    // attach the correct AutoDM to this exact scheduled post.
    slot.linkdmDraftCode,
  ];
  return lines.filter(Boolean).join("\n").slice(0, 2100);
}

async function postForm(path, params) {
  const body = new URLSearchParams(params);
  const response = await fetch(`${INSTAGRAM_GRAPH_API}/${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(25_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Instagram request failed (${response.status})`);
  return data;
}

async function instagramProfile(token) {
  const response = await fetch(`${INSTAGRAM_GRAPH_API}/me?fields=id,username&access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || !data.id) throw new Error(data.error?.message || "Instagram account could not be resolved");
  if (data.username && data.username.toLowerCase() !== "deals_aholic") {
    throw new Error(`Connected Instagram account is @${data.username}, expected @deals_aholic`);
  }
  return data;
}

async function publishInstagram(imageUrl, caption, token) {
  const profile = await instagramProfile(token);
  const container = await postForm(`${profile.id}/media`, {
    image_url: imageUrl,
    caption,
    access_token: token,
  });
  if (!container.id) throw new Error("Instagram did not return a media container ID");

  const published = await postForm(`${profile.id}/media_publish`, {
    creation_id: container.id,
    access_token: token,
  });
  if (!published.id) throw new Error("Instagram did not return a published media ID");
  return { containerId: container.id, mediaId: published.id, username: profile.username || null };
}

export default async function handler() {
  const now = easternNow();
  if (!SLOT_HOURS.has(now.hour) || now.minute >= RETRY_WINDOW_MINUTES) {
    return Response.json({ skipped: "outside Instagram publishing window", now });
  }

  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) throw new Error("INSTAGRAM_ACCESS_TOKEN is not configured");

  const store = getStore("instagram-daily-plan");
  const planKey = `plan-${now.date}`;
  const plan = await store.get(planKey, { type: "json" }).catch(() => null);
  if (!plan?.slots?.[now.hour]) {
    return Response.json({ skipped: "no prepared plan for this slot", date: now.date, hour: now.hour }, { status: 409 });
  }

  const slot = plan.slots[now.hour];
  if (slot.instagramStatus === "published" && slot.instagramMediaId) {
    return Response.json({ skipped: "Instagram slot already published", mediaId: slot.instagramMediaId });
  }

  // Never publish without a LinkDM draft. This prevents a live Instagram post
  // from going out without the requested comment-to-DM automation.
  if (!slot.linkdmDraftCode || slot.linkdmStatus !== "ready") {
    slot.instagramStatus = "blocked_linkdm";
    slot.lastError = "LinkDM draft code is missing";
    slot.retryCount = Number(slot.retryCount || 0) + 1;
    plan.updatedAt = new Date().toISOString();
    await store.setJSON(planKey, plan);
    return Response.json({ blocked: "LinkDM draft code is missing", date: now.date, hour: now.hour }, { status: 409 });
  }

  slot.instagramStatus = "publishing";
  slot.lastAttemptAt = new Date().toISOString();
  plan.updatedAt = slot.lastAttemptAt;
  await store.setJSON(planKey, plan);

  try {
    const published = await publishInstagram(slot.socialImageUrl, buildCaption(slot), token);
    slot.instagramStatus = "published";
    slot.instagramMediaId = published.mediaId;
    slot.instagramContainerId = published.containerId;
    slot.publishedAt = new Date().toISOString();
    slot.lastError = null;
    slot.linkdmStatus = "awaiting_comment_test";
    plan.updatedAt = slot.publishedAt;
    plan.status = Object.values(plan.slots).every((s) => s.instagramStatus === "published") ? "published" : "in_progress";
    await store.setJSON(planKey, plan);
    console.log("[publish-instagram-deal]", JSON.stringify({
      date: now.date, hour: now.hour, dealId: slot.dealId, mediaId: slot.instagramMediaId,
      destinationUrl: slot.destinationUrl, linkdmDraftCode: slot.linkdmDraftCode,
    }));
    return Response.json({ ok: true, date: now.date, hour: now.hour, dealId: slot.dealId, instagramMediaId: slot.instagramMediaId });
  } catch (error) {
    slot.instagramStatus = "retrying";
    slot.retryCount = Number(slot.retryCount || 0) + 1;
    slot.lastError = error.message;
    slot.lastAttemptAt = new Date().toISOString();
    plan.updatedAt = slot.lastAttemptAt;
    await store.setJSON(planKey, plan);
    console.error("[publish-instagram-deal]", error);
    return Response.json({ error: error.message, retryCount: slot.retryCount }, { status: 502 });
  }
}

export const config = { schedule: "*/5 * * * *" };
