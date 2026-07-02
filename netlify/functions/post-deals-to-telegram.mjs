import { getStore } from "@netlify/blobs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POSTED_STORE_NAME = "telegram-posted";

export default async function handler() {
  try {
    console.log("⏰ post-deals-to-telegram triggered");

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.error("❌ Missing Telegram env vars");
      return;
    }

    // Get approved deals from your site's blob store
    const submissionsStore = getStore("submissions");
    const postedStore = getStore(POSTED_STORE_NAME);

    // Get list of already-posted deal IDs so we don't repost
    let postedIds = [];
    try {
      const postedData = await postedStore.get("posted-ids", { type: "json" });
      if (postedData && Array.isArray(postedData)) {
        postedIds = postedData;
      }
    } catch (e) {
      console.log("No posted-ids yet, starting fresh");
    }

    // List all approved submissions
    const { blobs } = await submissionsStore.list();
    console.log(`Found ${blobs.length} total submissions`);

    const now = Date.now();
    let deals = [];

    for (const blob of blobs) {
      try {
        const deal = await submissionsStore.get(blob.key, { type: "json" });
        if (!deal) continue;

        // Only approved deals
        if (deal.status !== "approved") continue;

        // Skip already posted
        if (postedIds.includes(deal.id)) continue;

        // Skip expired deals
        if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) continue;

        // Must have a title and URL
        if (!deal.title || !deal.url) continue;

        deals.push(deal);
      } catch (e) {
        console.log(`Error reading blob ${blob.key}:`, e.message);
      }
    }

    console.log(`Found ${deals.length} unposted approved deals`);

    if (deals.length === 0) {
      console.log("No new deals to post");
      return;
    }

    // Sort by newest first
    deals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Post the first unposted deal only (one per run)
    const deal = deals[0];

    // Build the Telegram message
    const title = deal.title || "Amazing Deal!";
    const price = deal.price ? `💰 *Price: ${deal.price}*` : "";
    const originalPrice = deal.originalPrice ? `~~${deal.originalPrice}~~` : "";
    const discount = deal.discountPercent ? `🔥 *${deal.discountPercent}% OFF*` : "";
    const promoCode = deal.discountCode ? `\n🎟️ *Promo Code: \`${deal.discountCode}\`*` : "";
    const store = deal.store ? `🏪 ${deal.store.charAt(0).toUpperCase() + deal.store.slice(1)}` : "🏪 Amazon";

    // Build deal URL with affiliate tag
    let dealUrl = deal.url || "";
    if (dealUrl.includes("amazon.com") && !dealUrl.includes("tag=")) {
      dealUrl += dealUrl.includes("?") ? "&tag=kethya08-20" : "?tag=kethya08-20";
    }

    const message = [
      `🛍️ *${title}*`,
      ``,
      discount,
      price,
      originalPrice ? `📦 Was: ${originalPrice}` : "",
      promoCode,
      ``,
      store,
      ``,
      `👉 [Grab this deal](${dealUrl})`,
      ``,
      `🔔 @dealsaholic`,
    ].filter(Boolean).join("\n");

    // Post with photo if image available
    const imageUrl = deal.image || deal.imageUrl || null;
    let telegramSuccess = false;

    if (imageUrl) {
      console.log(`Posting with photo: ${imageUrl}`);
      const photoRes = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            photo: imageUrl,
            caption: message,
            parse_mode: "Markdown",
          }),
        }
      );
      const photoData = await photoRes.json();
      console.log("Telegram photo response:", JSON.stringify(photoData));

      if (photoData.ok) {
        telegramSuccess = true;
      } else {
        // Photo failed — try text only
        console.log("Photo failed, trying text only...");
        const textRes = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHAT_ID,
              text: message,
              parse_mode: "Markdown",
            }),
          }
        );
        const textData = await textRes.json();
        console.log("Telegram text response:", JSON.stringify(textData));
        if (textData.ok) telegramSuccess = true;
      }
    } else {
      // No image — text only
      console.log("No image, posting text only");
      const textRes = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: "Markdown",
          }),
        }
      );
      const textData = await textRes.json();
      console.log("Telegram text response:", JSON.stringify(textData));
      if (textData.ok) telegramSuccess = true;
    }

    // Mark as posted so we don't repost it
    if (telegramSuccess) {
      postedIds.push(deal.id);
      // Keep only last 500 posted IDs to avoid blob growing forever
      if (postedIds.length > 500) {
        postedIds = postedIds.slice(-500);
      }
      await postedStore.set("posted-ids", JSON.stringify(postedIds));
      console.log(`✅ Successfully posted deal: ${deal.title}`);
    }

  } catch (err) {
    console.error("❌ Error in post-deals-to-telegram:", err);
  }
}

export const config = {
  schedule: "*/10 * * * *", // runs every 10 minutes
};
