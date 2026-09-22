import { getStore } from "@netlify/blobs";
import { engagementPrompt } from "./social-caption-bank.mjs";

const FACEBOOK_GRAPH_API = "https://graph.facebook.com/v22.0";
const INSTAGRAM_GRAPH_API = "https://graph.instagram.com/v25.0";
const SITE_URL = "https://deals-aholic.com";
const TIME_ZONE = "America/New_York";
const SLOTS = new Set(["09", "14", "19"]);
const SHOPFORLESS_PAGE_ID = process.env.SHOPFORLESS_PAGE_ID || "101455682008516";

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

function dealPageUrl(deal) {
  const id = String(deal?.id || deal?.asin || "").trim();
  // Send social visitors through Deals-Aholic first. This preserves the site
  // redirect/affiliate tracking rather than placing an Amazon URL in a post.
  return id ? `${SITE_URL}/d/${encodeURIComponent(id)}` : String(deal?.url || SITE_URL);
}

function caption(deal, promptIndex) {
  const lines = [
    "🔥 Deal drop!",
    deal.title,
    deal.price ? `💰 ${deal.price}${deal.originalPrice ? ` (was ${deal.originalPrice})` : ""}` : "",
    engagementPrompt(promptIndex),
    "",
    `Shop this exact deal: ${dealPageUrl(deal)}`,
    "Link is also in our bio. Follow @deals_aholic for more daily finds, price drops, and promo codes.",
    "",
    "#ad As an Amazon Associate, Deals-Aholic may earn from qualifying purchases.",
    "#DealsAholic #AmazonFinds #DealAlert #Deals #ShoppingDeals #Sale",
  ];
  return lines.filter((line, index) => line || index > 2).join("\n").slice(0, 2100);
}

async function postForm(apiBase, path, params) {
  const body = new URLSearchParams(params);
  const response = await fetch(`${apiBase}/${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(25_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Meta request failed (${response.status})`);
  return data;
}

async function publishFacebook(cardUrl, postCaption, token) {
  return postForm(FACEBOOK_GRAPH_API, `${SHOPFORLESS_PAGE_ID}/photos`, {
    url: cardUrl,
    caption: postCaption,
    published: "true",
    access_token: token,
  });
}

async function instagramProfile(token) {
  const response = await fetch(`${INSTAGRAM_GRAPH_API}/me?fields=id,username&access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || !data.id) throw new Error(data.error?.message || "Instagram account could not be resolved");
  return data;
}

async function publishInstagram(cardUrl, postCaption, token) {
  const profile = await instagramProfile(token);
  const container = await postForm(INSTAGRAM_GRAPH_API, `${profile.id}/media`, {
    image_url: cardUrl,
    caption: postCaption,
    access_token: token,
  });
  if (!container.id) throw new Error("Instagram did not return a media container ID");
  return postForm(INSTAGRAM_GRAPH_API, `${profile.id}/media_publish`, {
    creation_id: container.id,
    access_token: token,
  });
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
  // Social posts remain paused until the editorial collage workflow is
  // approved. This prevents the scheduler from sending another generic card.
  if (process.env.SOCIAL_COLLAGE_ENABLED !== "true") {
    return new Response(JSON.stringify({ skipped: "social collage publishing is paused" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const slot = currentEasternSlot();
  if (!slot) return new Response(JSON.stringify({ skipped: "outside scheduled social window" }), { headers: { "Content-Type": "application/json" } });

  const instagramToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const facebookToken = process.env.SHOPFORLESS_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN || process.env.META_SYSTEM_TOKEN;
  if (!instagramToken && !facebookToken) throw new Error("No social publishing token is configured");

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
  const postCaption = caption(deal, state.usedDealKeys?.length || 0);
  const result = { deal: { id: key, title: deal.title }, instagram: null, facebook: null, errors: [] };

  if (instagramToken) {
    try { result.instagram = await publishInstagram(cardUrl, postCaption, instagramToken); }
    catch (error) { result.errors.push({ platform: "instagram", message: error.message }); }
  }
  if (facebookToken) {
    try { result.facebook = await publishFacebook(cardUrl, postCaption, facebookToken); }
    catch (error) { result.errors.push({ platform: "facebook", message: error.message }); }
  }

  if (!result.instagram && !result.facebook) {
    console.error("[publish-social-deals] No platform accepted post", JSON.stringify(result));
    throw new Error(result.errors.map((item) => `${item.platform}: ${item.message}`).join(" | ") || "No social platform is configured");
  }

  // A successful post to either authorized channel consumes the time slot to
  // prevent duplicate Instagram posts when the Facebook Page token is repaired.
  state.usedDealKeys = [...new Set([...(state.usedDealKeys || []), key])].slice(-100);
  state.slots[slot.hour] = {
    key,
    at: new Date().toISOString(),
    instagram: result.instagram?.id || null,
    facebook: result.facebook?.id || null,
    errors: result.errors,
  };
  await stateStore.setJSON(stateKey, state);
  console.log("[publish-social-deals]", JSON.stringify(result));
  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
}

export const config = { schedule: "*/5 * * * *" };
