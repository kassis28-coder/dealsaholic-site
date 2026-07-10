import { getStore } from "@netlify/blobs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POSTED_STORE_NAME = "telegram-posted";

// Telegram caption limit for sendPhoto is 1024 chars.
// sendMessage limit is 4096 chars.
const PHOTO_CAPTION_LIMIT = 1024;
const TEXT_MESSAGE_LIMIT = 4096;

// Strip Amazon image modifier junk (e.g. ".jpg_BO30,255,255,255_QL100_.jpg")
// so stored image URLs are clean before sending to Telegram.
function cleanAmazonImageUrl(url) {
  if (!url) return url;
  const m = url.match(/(https:\/\/m\.media-amazon\.com\/images\/[A-Z]\/[A-Za-z0-9+%]+)/i);
  if (m) return m[1] + '._SL1500_.jpg';
  return url;
}

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

export default async function handler() {
  console.log("[TG] post-deals-to-telegram triggered");

  // ── Env check ───────────────────────────────────────────────────────────────
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error(
      "[TG] FATAL: Missing env vars. " +
      `TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN ? "SET" : "MISSING"} ` +
      `TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID ? "SET" : "MISSING"}`
    );
    return;
  }
  console.log(`[TG] Env OK — chat_id=${TELEGRAM_CHAT_ID}`);

  const submissionsStore = getStore("submissions");
  const postedStore = getStore(POSTED_STORE_NAME);

  // ── Load already-posted IDs ─────────────────────────────────────────────────
  let postedIds = [];
  try {
    const postedData = await postedStore.get("posted-ids", { type: "json" });
    if (postedData && Array.isArray(postedData)) {
      postedIds = postedData;
      console.log(`[TG] Loaded ${postedIds.length} previously-posted IDs`);
    }
  } catch (e) {
    console.log("[TG] No posted-ids yet, starting fresh");
  }

  // ── List all submissions ────────────────────────────────────────────────────
  let blobs;
  try {
    ({ blobs } = await submissionsStore.list());
  } catch (e) {
    console.error("[TG] FATAL: Failed to list submissions store:", e.message);
    return;
  }
  console.log(`[TG] Total blobs in submissions store: ${blobs.length}`);

  const now = Date.now();
  const deals = [];

  for (const blob of blobs) {
    if (blob.key === "index") continue;
    try {
      const deal = await submissionsStore.get(blob.key, { type: "json" });
      if (!deal) continue;
      if (deal.status !== "approved") {
        console.log(`[TG] Skipping ${blob.key}: status="${deal.status}"`);
        continue;
      }
      if (postedIds.includes(deal.id)) continue;
      if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) {
        console.log(`[TG] Skipping ${blob.key}: expired`);
        continue;
      }
      if (!deal.title || !deal.url) {
        console.log(`[TG] Skipping ${blob.key}: missing title or url`);
        continue;
      }
      deals.push(deal);
    } catch (e) {
      console.error(`[TG] Error reading blob "${blob.key}":`, e.message);
    }
  }

  console.log(`[TG] Unposted approved deals: ${deals.length}`);

  if (deals.length === 0) {
    console.log("[TG] Nothing to post — exiting");
    return;
  }

  // Post the newest deal first
  deals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const deal = deals[0];

  console.log(
    `[TG] Posting deal: "${deal.title?.slice(0, 60)}" ` +
    `price=${deal.price} imageUrl=${deal.imageUrl || deal.image || "(none)"}`
  );

  // ── Build message ───────────────────────────────────────────────────────────
  const title = deal.title || "Amazing Deal!";
  const price = deal.price ? `Price: ${deal.price}` : "";
  const discount = deal.discountPercent ? `${deal.discountPercent}% OFF` : "";
  const promoCode = deal.discountCode ? `Promo Code: ${deal.discountCode}` : "";
  const storeName = deal.store
    ? deal.store.charAt(0).toUpperCase() + deal.store.slice(1)
    : "Amazon";

  let dealUrl = deal.url || "";
  if (dealUrl.includes("amazon.com") && !dealUrl.includes("tag=")) {
    dealUrl += dealUrl.includes("?") ? "&tag=kethya08-20" : "?tag=kethya08-20";
  }

  const messageLines = [
    title,
    "",
    discount,
    price,
    promoCode,
    "",
    `Store: ${storeName}`,
    "",
    `Get it here: ${dealUrl}`,
    "",
    "@dealsaholic",
  ].filter(Boolean);

  const fullMessage = messageLines.join("\n");
  const imageUrl = cleanAmazonImageUrl(deal.image || deal.imageUrl || null);
  let telegramSuccess = false;

  // ── Post to Telegram ────────────────────────────────────────────────────────
  if (imageUrl) {
    console.log(`[TG] sendPhoto with image: ${imageUrl}`);
    // BUG FIX: caption must be <= 1024 chars for sendPhoto
    const photoCaption = truncate(fullMessage, PHOTO_CAPTION_LIMIT);

    const photoRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          photo: imageUrl,
          caption: photoCaption,
        }),
      }
    );
    const photoData = await photoRes.json();
    // BUG FIX: always log the full API response so failures are visible
    console.log(`[TG] sendPhoto response: ${JSON.stringify(photoData)}`);

    if (photoData.ok) {
      telegramSuccess = true;
      console.log(`[TG] sendPhoto succeeded`);
    } else {
      console.error(
        `[TG] sendPhoto failed (code=${photoData.error_code} ` +
        `desc="${photoData.description}") — falling back to sendMessage`
      );
      const textRes = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: truncate(fullMessage, TEXT_MESSAGE_LIMIT),
          }),
        }
      );
      const textData = await textRes.json();
      console.log(`[TG] sendMessage (fallback) response: ${JSON.stringify(textData)}`);
      if (textData.ok) {
        telegramSuccess = true;
        console.log(`[TG] sendMessage (fallback) succeeded`);
      } else {
        console.error(
          `[TG] sendMessage fallback also failed: ` +
          `code=${textData.error_code} desc="${textData.description}"`
        );
      }
    }
  } else {
    console.log(`[TG] No image for deal — sending text-only message`);
    const textRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: truncate(fullMessage, TEXT_MESSAGE_LIMIT),
        }),
      }
    );
    const textData = await textRes.json();
    console.log(`[TG] sendMessage response: ${JSON.stringify(textData)}`);
    if (textData.ok) {
      telegramSuccess = true;
      console.log(`[TG] sendMessage succeeded`);
    } else {
      console.error(
        `[TG] sendMessage failed: ` +
        `code=${textData.error_code} desc="${textData.description}"`
      );
    }
  }

  // ── Mark as posted ──────────────────────────────────────────────────────────
  if (telegramSuccess) {
    postedIds.push(deal.id);
    if (postedIds.length > 500) postedIds = postedIds.slice(-500);
    await postedStore.setJSON("posted-ids", postedIds);
    console.log(`[TG] Marked deal ${deal.id} as posted. Total posted: ${postedIds.length}`);
  } else {
    console.error(`[TG] Deal "${deal.title?.slice(0, 60)}" was NOT posted to Telegram`);
  }
}

export const config = {
  schedule: "*/10 * * * *",
};
