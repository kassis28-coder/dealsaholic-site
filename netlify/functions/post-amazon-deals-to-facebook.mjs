import { getStore } from "@netlify/blobs";

const LOCK_STALE_MS = 30 * 60 * 1000;

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

  lines.push("");
  lines.push(siteCTAs[Math.floor(Date.now() / 3600000) % siteCTAs.length]);
  lines.push("https://deals-aholic.com");
  lines.push("");
  lines.push("⚠️ Price valid at the time posted but may change at any time.");
  lines.push("#ad");

  const text = lines.join("\n");
  // Telegram caption limit is 1024 chars
  return text.length > 1024 ? text.substring(0, 1021) + "..." : text;
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
  const pageId   = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  const token    = process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  if (!pageId || !token) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing Facebook credentials" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

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

  // Build target batch (up to 5 unposted valid deals)
  const targets = [];
  for (const deal of data.deals) {
    if (!validateDeal(deal)) continue;

    const key = deal.asin || deal.url || deal.title;
    if (posted.includes(key)) continue;

    const exists = await alreadyPosted(deal, pageId, token);
    if (exists) {
      posted.push(key);
      continue;
    }

    targets.push(deal);
    if (targets.length >= 5) break;
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

  for (const deal of targets) {
    const style = Math.floor(Math.random() * 15);

    // ── Facebook ──────────────────────────────────────────────────────────────
    let fbOk = false;
    try {
      const result = await postToFacebook(deal, pageId, token, style);
      fbOk = true;
      console.log(`[FB] Posted: "${deal.title.substring(0, 60)}" | id: ${result.id}`);
    } catch (err) {
      console.error(`[FB] Failed: "${deal.title.substring(0, 60)}" | ${err.message}`);
    }

    // ── Telegram (same deal, same caption style) ──────────────────────────────
    let tgOk = false;
    if (botToken && chatId) {
      try {
        const tgResult = await postToTelegram(deal, botToken, chatId, style);
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
      results.push({ title: deal.title, fbOk, tgOk });
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
