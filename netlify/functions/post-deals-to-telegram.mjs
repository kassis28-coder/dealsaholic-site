import { getStore } from "@netlify/blobs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POSTED_STORE_NAME = "telegram-posted";

// Telegram caption limit for sendPhoto is 1024 chars.
// sendMessage limit is 4096 chars.
const PHOTO_CAPTION_LIMIT = 1024;
const TEXT_MESSAGE_LIMIT = 4096;

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

// ââ Verify bot token is valid and log bot info ââââââââââââââââââââââââââââââââ
async function verifyBotToken() {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
    );
    const data = await res.json();
    if (data.ok) {
      console.log(
        `[TG] Bot verified: @${data.result.username} (id=${data.result.id})`
      );
      return true;
    } else {
      console.error(
        `[TG] FATAL: getMe failed â token is invalid or revoked. ` +
        `error_code=${data.error_code} description="${data.description}"`
      );
      return false;
    }
  } catch (e) {
    console.error(`[TG] FATAL: getMe request threw:`, e.message);
    return false;
  }
}

export default async function handler() {
  console.log("[TG] post-deals-to-telegram triggered");

  // ââ Env check âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error(
      "[TG] FATAL: Missing env vars. " +
      `TELEGRAM_BOT_TOKEN =${TELEGRAM_BOT_TOKEN ? "SET" : "MISSING"} ` +
      `TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID ? "SET" : "MISSING"}`
    );
    console.error(
      "[TG] TELEGRAM_CHAT_ID must be the channel username (e.g. @dealsaholic) " +
      "or numeric ID with -100 prefix (e.g. -1001234567890). " +
      "Bot MUST be added as admin of the channel."
    );
    return;
  }
  console.log(
    `[TG] Env OK â chat_id="${TELEGRAM_CHAT_ID}" ` +
    `(must be @channelname or -100XXXXXXXXXX format)`
  );

  // ââ Verify bot token before doing anything else ââââââââââââââââââââââââââ
  const botOk = await verifyBotToken();
  if (!botOk) return;

  const submissionsStore = getStore("submissions");
  const postedStore = getStore(POSTED_STORE_NAME);

  // ââ Load already-posted IDs âââââââââââââââââââââââââââââââââââââââââââââââââ
  let postedIds = [];
  try {
    // Use store.get() + JSON.parse â avoids setJSON/getJSON version differences
    const raw = await postedStore.get("posted-ids");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        postedIds = parsed;
        console.log(`[TG] Loaded ${postedIds.length} previously-posted IDs`);
      }
    }
  } catch (e) {
    console.log("[TG] No posted-ids yet, starting fresh");
  }

  // ââ List all submissions ââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
      if (postedIds.includes(deal.id)) {
        // already posted â skip silently
        continue;
      }
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
    console.log("[TG] Nothing to post â exiting");
    return;
  }

  // Post the newest deal first
  deals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const deal = deals[0];

  console.log(
    `[TG] Posting deal: "${deal.title?.slice(0, 60)}" ` +
    `price=${deal.price} imageUrl=${deal.imageUrl || deal.image || "(none)"}`
  );

  // ââ Build message âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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
  const imageUrl = deal.image || deal.imageUrl || null;
  let telegramSuccess = false;

  // ââ Post to Telegram ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  if (imageUrl) {
    console.log(`[TG] sendPhoto with image: ${imageUrl}`);
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
    console.log(`[TG] sendPhoto response: ${JSON.stringify(photoData)}`);

    if (photoData.ok) {
      telegramSuccess = true;
      console.log(`[TG] â sendPhoto succeeded`);
    } else {
      console.error(
        `[TG] sendPhoto failed (code=${photoData.error_code} ` +
        `desc="${photoData.description}") â falling back to sendMessage`
      );
      if (photoData.error_code === 403) {
        console.error(
          `[TG] 403 Forbidden â the bot is NOT a member/admin of chat_id="${TELEEGIAM_CHAT_ID}". ` +
          `Go to your Telegram channel, open Settings â Administrators, and add the bot as admin.`
        );
      }
      // Fall back to text message
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
        console.log(`[TG] â sendMessage (fallback) succeeded`);
      } else {
        console.error(
          `[TG] â sendMessage fallback also failed: ` +
          `code=${textData.error_code} desc="${textData.description}"`
        );
        if (textData.error_code === 403) {
          console.error(
            `[TG] 403 Forbidden â bot is NOT admin of the channel. Add it in channel Settings â Administrators.`
          );
        }
      }
    }
  } else {
    // No image â send text-only message
    console.log(`[TG] No image for deal â sending text-only message`);
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
      console.log(`[TG] â sendMessage succeeded`);
    } else {
      console.error(
        `[TG] â sendMessage failed: ` +
        `code=${textData.error_code} desc="${textData.description}"`
      );
      if (textData.error_code === 403) {
        console.error(
          `[TG] 403 Forbidden â bot is NOT admin of channel "${TELEGRAM_CHAT_ID}". ` +
          `Add it in channel Settings â Administrators.`
        );
      }
    }
  }

  // ââ Mark as posted ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  if (telegramSuccess) {
    postedIds.push(deal.id);
    if (postedIds.length > 500) postedIds = postedIds.slice(-500);
    // Use set + JSON.stringify (avoids setJSON compatibility issues across
    // @netlify/blobs versions)
    await postedStore.set("posted-ids", JSON.stringify(postedIds));
    console.log(`[TG] Marked deal ${deal.id} as posted. Total posted: ${postedIds.length}`);
  } else {
    console.error(`[TG] â Deal "${deal.title?.slice(0, 60)}" was NOT posted to Telegram`);
  }
}

export const config = {
  schedule: "*/10 * * * *",
};
