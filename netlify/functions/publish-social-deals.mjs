import { getStore } from "@netlify/blobs";

const GRAPH_API = "https://graph.facebook.com/v22.0";
const SITE_URL = "https://deals-aholic.com";
const TIME_ZONE = "America/New_York";
const SLOTS = new Set(["09", "14", "19"]);
const PAGE_ID = process.env.SHOPFORLESS_PAGE_ID || "101455682008516";
const INSTAGRAM_PAGE_ID = process.env.DEALS_AHOLIC_FACEBOOK_PAGE_ID || "107936901106725";

function currentEasternSlot() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((item) => item.type !== "literal").map((item) => [item.type, item.value]));
  // Run only in the first five minutes of the scheduled hour. The hourly slot
  // is remembered in Blobs, so duplicate invocations cannot double-post.
  if (!SLOTS.has(value.hour) || Number(value.minute) > 4) return null;
  return { key: `${value.year}-${value.month}-${value.day}`, hour: value.hour };
}

function keyFor(deal) {
  return String(deal.id || deal.asin || deal.url || "");
}

function timestamp(deal) {
  const value = new Date(deal.createdAt || deal.fetchedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function usable(deal) {
  const title = String(deal?.title || "").trim();
  const url = String(deal?.url || "").trim();
  const image = String(deal?.image || deal?.imageUrl || "").trim();
  return Boolean(
    !deal?.needsReview && title.length >= 8 && !/^amazon deal$/i.test(title) && url && image &&
    !/<(?:html|body|head)(?:\s|>)/i.test(title)
  );
}

function caption(deal) {
  const lines = [
    "🔥 Deal drop!",
    deal.title,
    deal.price ? `💰 ${deal.price}${deal.originalPrice ? ` (was ${deal.originalPrice})` : ""}` : "",
    "",
    `Find this deal and more: ${SITE_URL}`,
    "Tap the link in our bio or visit the site before the price changes.",
    "",
    "#ad As an Amazon Associate, Deals-Aholic may earn from qualifying purchases.",
    "#DealsAholic #AmazonFinds #DealAlert #Deals #ShoppingDeals #Sale",
  ];
  return lines.filter((line, index) => line || index > 2).join("\n").slice(0, 2100);
}

async function graph(path, params) {
  const body = new URLSearchParams(params);
  const response = await fetch(`${GRAPH_API}/${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(20_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Meta request failed (${response.status})`);
  return data;
}

async function publishFacebook(cardUrl, postCaption, token) {
  return graph(`${PAGE_ID}/photos`, { url: cardUrl, caption: postCaption, published: "true", access_token: token });
}

async function waitForMedia(containerId, token) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(`${GRAPH_API}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => ({}));
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR" || data.error) throw new Error(data.error?.message || "Instagram media processing failed");
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }
  throw new Error("Instagram media processing timed out");
}

async function resolveInstagramAccountId(token) {
  const response = await fetch(`${GRAPH_API}/${INSTAGRAM_PAGE_ID}?fields=instagram_business_account&access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || "Could not read the Instagram account linked to Deals Aholic");
  return data.instagram_business_account?.id || "";
}

async function publishInstagram(instagramAccountId, cardUrl, postCaption, token) {
  const container = await graph(`${instagramAccountId}/media`, {
    image_url: cardUrl,
    caption: postCaption,
    access_token: token,
  });
  if (!container.id) throw new Error("Instagram did not return a media container");
  await waitForMedia(container.id, token);
  return graph(`${INSTAGRAM_ACCOUNT_ID}/media_publish`, { creation_id: container.id, access_token: token });
}

async function selectDeal(used) {
  const latest = await getStore("deals").get("latest", { type: "json" }).catch(() => null);
  const deals = Array.isArray(latest?.deals) ? [...latest.deals] : [];
  return deals
    .filter(usable)
    .sort((a, b) => (Number(b.discountPercent) || 0) - (Number(a.discountPercent) || 0) || timestamp(b) - timestamp(a))
    .find((deal) => !used.includes(keyFor(deal))) || null;
}

export default async function handler() {
  const slot = currentEasternSlot();
  if (!slot) return new Response(JSON.stringify({ skipped: "outside scheduled social window" }), { headers: { "Content-Type": "application/json" } });

  const token = process.env.META_SYSTEM_TOKEN;
  if (!token) throw new Error("META_SYSTEM_TOKEN is not configured");

  const stateStore = getStore("social-publishing-state");
  const stateKey = `daily-${slot.key}`;
  const state = await stateStore.get(stateKey, { type: "json" }).catch(() => null) || { usedDealKeys: [], slots: {} };
  if (state.slots?.[slot.hour]) return new Response(JSON.stringify({ skipped: "slot already processed", slot }), { headers: { "Content-Type": "application/json" } });

  const deal = await selectDeal(state.usedDealKeys || []);
  if (!deal) {
    state.slots[slot.hour] = { skipped: "no eligible deals", at: new Date().toISOString() };
    await stateStore.setJSON(stateKey, state);
    return new Response(JSON.stringify({ skipped: "no eligible deals" }), { headers: { "Content-Type": "application/json" } });
  }

  const key = keyFor(deal);
  const cardUrl = `${SITE_URL}/api/social-card?id=${encodeURIComponent(key)}`;
  const postCaption = caption(deal);
  const result = { deal: { id: key, title: deal.title }, facebook: null, instagram: null, errors: [] };

  try { result.facebook = await publishFacebook(cardUrl, postCaption, token); }
  catch (error) { result.errors.push({ platform: "facebook", message: error.message }); }
  try {
    const instagramAccountId = await resolveInstagramAccountId(token);
    if (!instagramAccountId) throw new Error("No Instagram professional account is linked to the Deals Aholic Facebook Page");
    result.instagram = await publishInstagram(instagramAccountId, cardUrl, postCaption, token);
  } catch (error) {
    result.errors.push({ platform: "instagram", message: error.message });
  }

  // Always consume a time slot once attempted, which prevents retry storms or
  // duplicate posts. Errors are returned in Netlify logs for a safe manual fix.
  state.usedDealKeys = [...new Set([...(state.usedDealKeys || []), key])].slice(-100);
  state.slots[slot.hour] = { key, at: new Date().toISOString(), facebook: result.facebook?.id || null, instagram: result.instagram?.id || null, errors: result.errors };
  await stateStore.setJSON(stateKey, state);

  if (!result.facebook && !result.instagram) {
    console.error("[publish-social-deals] no platform accepted post", JSON.stringify(result));
    throw new Error(result.errors.map((item) => `${item.platform}: ${item.message}`).join(" | "));
  }
  console.log("[publish-social-deals]", JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

export const config = { schedule: "*/5 * * * *" };
