import { getStore } from "@netlify/blobs";

const LOCK_STALE_MS = 30 * 60 * 1000;


async function getJoyLinkUrl(amazonUrl, asin) {
  const apiKey = process.env.JOYLINK_API_KEY;
  if (!apiKey || !amazonUrl) return null;

  const cache = getStore("joylink-cache");
  const trackingId = process.env.AMAZON_PARTNER_TAG || "daholic-20";
  const cacheKey = `${trackingId}:${asin || amazonUrl}`;
  try {
    const cached = await cache.get(cacheKey, { type: "json" });
    if (cached?.url) return cached.url;
  } catch {}

  try {
    const res = await fetch("https://api.joylink.io/public/createlink", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({
        destination: amazonUrl,
        trackingid: trackingId,
      }),
    });
    const data = await res.json();
    if (res.ok && data.url) {
      await cache.setJSON(cacheKey, { url: data.url, createdAt: new Date().toISOString() }).catch(() => {});
      return data.url;
    }
    console.error("JoyLink API error:", JSON.stringify(data));
  } catch (err) {
    console.error("JoyLink request failed:", err.message);
  }
  return null;
}

function buildCaption(deal, style = 0) {
  const headlines = [
    "🔥 Amazon Deal Alert",
    "⚡ Limited Time Deal",
    "🛒 Amazon Savings Alert",
    "💥 Today's Hot Deal",
    "🚨 Price Drop Alert",
    "✨ Deal You Don't Want To Miss",
    "🏷️ Big Savings Alert",
    "🔥 Hidden Amazon Deal",
    "💰 Amazing Price Drop",
    "🛍️ Shopper's Pick",
    "⭐ Top Deal Find",
    "🎯 Deal Worth Checking Out",
    "⏰ Hurry Before It's Gone",
    "🔥 Trending Deal Alert",
    "💎 Great Find Today",
  ];

  const lines = [];
  lines.push(headlines[style % headlines.length]);
  lines.push("");
  lines.push(`🛍️ ${deal.title}`);
  lines.push(`💰 Price: ${deal.price}`);

  if (deal.originalPrice) lines.push(`🏷️ Was: ${deal.originalPrice}`);
  if (deal.discountPercent) lines.push(`🔥 Save ${deal.discountPercent}%`);

  lines.push("");
  lines.push(`🔗 ${deal.url}`);

  const siteCTAs = [
    "🌟 See all current deals:",
    "🔥 More deals updated daily:",
    "🛒 Find more amazing deals:",
    "💎 Discover today's best savings:",
    "🏷️ Browse more discounts:",
    "✨ More deals waiting for you:",
    "🚀 New deals added every day:",
    "👀 Looking for more bargains?",
    "🛍️ Shop more deals here:",
    "⭐ Don't miss today's deals:",
  ];

  const footer = [
    "",
    siteCTAs[Math.floor(Date.now() / 3600000) % siteCTAs.length],
    "https://deals-aholic.com",
    "",
    "⚠️ Price valid at the time posted but may change at any time.",
    "#ad",
  ].join("\n");

  const text = lines.join("\n");
  // Keep the CTA and disclaimer in Telegram's 1024-character caption limit.
  const maxBodyLength = 1024 - footer.length;
  return text.length > maxBodyLength
    ? text.substring(0, maxBodyLength - 3) + "..." + footer
    : text + footer;
}

function validateDeal(deal) {
  if (!deal.title) return false;
  if (!deal.url) return false;
  if (!deal.image) return false;
  if (!deal.discountPercent || deal.discountPercent < 20) return false;
  if (deal.needsReview) return false;
  return true;
}

async function alreadyPosted(deal, pageId, token) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${pageId}/posts?fields=message&limit=100&access_token=${token}`
    );
    const data = await res.json();
    if (!data.data) return false;
    return data.data.some(post => {
      const msg = post.message || "";
      return (
        (deal.asin && msg.includes(deal.asin)) ||
        (deal.title && msg.includes(deal.title.substring(0, 40)))
      );
    });
  } catch (err) {
    console.error("Facebook duplicate check failed:", err.message);
    return false;
  }
}

async function postToFacebook(deal, pageId, token, style) {
  const caption = buildCaption(deal, style);
  const params = new URLSearchParams({
    url: deal.image,
    caption,
    access_token: token,
    published: "true",
  });
  const res = await fetch(`https://graph.facebook.com/${pageId}/photos`, {
    method: "POST",
    body: params,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function postToTelegram(deal, botToken, chatId, style) {
  const caption = buildCaption(deal, style);
  const base = `https://api.telegram.org/bot${botToken}`;

  // Try sendPhoto first
  const photoRes = await fetch(`${base}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: deal.image, caption }),
  });
  const photoData = await photoRes.json();
  if (photoData.ok) {
    console.log(`[TG] sendPhoto OK | "${deal.title.substring(0, 60)}"`);
    return { ok: true };
  }

  console.warn(`[TG] sendPhoto failed (${photoData.error_code}): ${photoData.description} — falling back to sendMessage`);

  // Fallback: text-only
  const msgRes = await fetch(`${base}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: caption }),
  });
  const msgData = await msgRes.json();
  if (msgData.ok) {
    console.log(`[TG] sendMessage OK | "${deal.title.substring(0, 60)}"`);
    return { ok: true };
  }

  console.error(`[TG] sendMessage failed (${msgData.error_code}): ${msgData.description}`);
  return { ok: false, error: `(${msgData.error_code}) ${msgData.description}` };
}

export default async () => {
  const dealsAholicPage = {
    name: "Deals-Aholic",
    pageId: process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID,
    token: process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN,
  };
  const savings101Page = {
    name: "101 Savings",
    pageId: process.env.FACEBOOK_101SAVINGS_PAGE_ID,
    token: process.env.FACEBOOK_101SAVINGS_PAGE_TOKEN,
  };
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  if (!dealsAholicPage.pageId || !dealsAholicPage.token) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing Deals-Aholic Facebook credentials" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  // Use both pages only after 101 Savings has been securely configured in
  // Netlify. Until then, preserve the existing Deals-Aholic posting behavior.
  const facebookPages = [dealsAholicPage];
  if (savings101Page.pageId && savings101Page.token) facebookPages.push(savings101Page);
  const maxPostsPerRun = facebookPages.length === 2 ? 6 : 5;

  const dealStore = getStore("deals");
  const data = await dealStore.get("latest", { type: "json" });

  if (!data || !Array.isArray(data.deals)) {
    return new Response(
      JSON.stringify({ success: true, message: "No Amazon deals found" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const store = getStore("amazon-facebook-posts");

  // Distributed lock — prevent duplicate runs
  const existingLock = await store.get("posting-lock", { type: "json" });
  if (
    existingLock &&
    existingLock.startedAt &&
    Date.now() - new Date(existingLock.startedAt).getTime() < LOCK_STALE_MS
  ) {
    return new Response(
      JSON.stringify({ success: true, message: "Posting already running" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  await store.setJSON("posting-lock", { startedAt: new Date().toISOString() });

  let posted = [];
  try { posted = await store.get("posted", { type: "json" }) || []; } catch {}

  // Build target batch. With both pages connected, publish six distinct deals:
  // three to each page. A deal is stored globally after a successful post, so it
  // cannot be sent to the other page in a later run.
  const targets = [];
  for (const deal of data.deals) {
    if (!validateDeal(deal)) continue;

    const key = deal.asin || deal.url || deal.title;
    if (posted.includes(key)) continue;

    // Check every connected Page. This also prevents a deal posted before this
    // rotation was added from being reused on the other Page.
    const existsOnAnyPage = await Promise.all(
      facebookPages.map(page => alreadyPosted(deal, page.pageId, page.token))
    );
    if (existsOnAnyPage.some(Boolean)) {
      posted.push(key);
      continue;
    }

    targets.push(deal);
    if (targets.length >= maxPostsPerRun) break;
  }

  if (targets.length === 0) {
    await store.setJSON("posted", posted);
    await store.delete("posting-lock");
    return new Response(
      JSON.stringify({ success: true, message: "No new Amazon deals to post" }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const results = [];

  for (const [dealIndex, deal] of targets.entries()) {
    const joylinkUrl = await getJoyLinkUrl(deal.url, deal.asin || null);
    if (!joylinkUrl) {
      console.warn(`[JoyLink] Deeplink unavailable for ${deal.asin || deal.url}; using raw Amazon URL.`);
    }
    const postDeal = { ...deal, url: joylinkUrl || deal.url };
    const style = Math.floor(Math.random() * 15);

    // ── Facebook ──────────────────────────────────────────────────────────────
    // Alternate destinations. With six posts, each Page receives exactly three.
    const destination = facebookPages[dealIndex % facebookPages.length];
    let fbOk = false;
    try {
      const result = await postToFacebook(postDeal, destination.pageId, destination.token, style);
      fbOk = true;
      console.log(`[FB] Posted to ${destination.name}: "${deal.title.substring(0, 60)}" | id: ${result.id}`);
    } catch (err) {
      console.error(`[FB] Failed for ${destination.name}: "${deal.title.substring(0, 60)}" | ${err.message}`);
    }

    // ── Telegram (same deal, same caption style) ──────────────────────────────
    let tgOk = false;
    if (botToken && chatId) {
      try {
        const tgResult = await postToTelegram(postDeal, botToken, chatId, style);
        tgOk = tgResult.ok;
      } catch (err) {
        console.error(`[TG] Failed: "${deal.title.substring(0, 60)}" | ${err.message}`);
      }
    } else {
      console.warn("[TG] Skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    }

    // Mark as posted if at least one platform succeeded
    if (fbOk || tgOk) {
      posted.push(deal.asin || deal.url);
      results.push({ title: deal.title, facebookPage: destination.name, fbOk, tgOk });
    }
  }

  await store.setJSON("posted", posted);
  await store.delete("posting-lock");

  return new Response(
    JSON.stringify({ success: true, posted: results }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config = { schedule: "0 * * * *" };
