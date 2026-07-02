import { getStore } from "@netlify/blobs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POSTED_STORE_NAME = "telegram-posted";

export default async function handler() {
    try {
          console.log("post-deals-to-telegram triggered");

      if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
              console.error("Missing Telegram env vars");
              return;
      }

      const submissionsStore = getStore("submissions");
          const postedStore = getStore(POSTED_STORE_NAME);

      let postedIds = [];
          try {
                  const postedData = await postedStore.get("posted-ids", { type: "json" });
                  if (postedData && Array.isArray(postedData)) {
                            postedIds = postedData;
                  }
          } catch (e) {
                  console.log("No posted-ids yet, starting fresh");
          }

      const { blobs } = await submissionsStore.list();
          console.log(`Found ${blobs.length} total submissions`);

      const now = Date.now();
          let deals = [];

      for (const blob of blobs) {
              try {
                        const deal = await submissionsStore.get(blob.key, { type: "json" });
                        if (!deal) continue;
                        if (deal.status !== "approved") continue;
                        if (postedIds.includes(deal.id)) continue;
                        if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) continue;
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

      deals.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          const deal = deals[0];

      const title = deal.title || "Amazing Deal!";
          const price = deal.price ? `Price: ${deal.price}` : "";
          const discount = deal.discountPercent ? `${deal.discountPercent}% OFF` : "";
          const promoCode = deal.discountCode ? `Promo Code: ${deal.discountCode}` : "";
          const store = deal.store ? deal.store.charAt(0).toUpperCase() + deal.store.slice(1) : "Amazon";

      let dealUrl = deal.url || "";
          if (dealUrl.includes("amazon.com") && !dealUrl.includes("tag=")) {
                  dealUrl += dealUrl.includes("?") ? "&tag=kethya08-20" : "?tag=kethya08-20";
          }

      const lines = [
              `${title}`,
              "",
              discount ? `${discount}` : "",
              price ? `${price}` : "",
              promoCode ? `${promoCode}` : "",
              "",
              `Store: ${store}`,
              "",
              `Get it here: ${dealUrl}`,
              "",
              `@dealsaholic`,
            ].filter(Boolean);

      const message = lines.join("\n");
          const imageUrl = deal.image || deal.imageUrl || null;
          let telegramSuccess = false;

      if (imageUrl) {
              const photoRes = await fetch(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
                {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                          chat_id: TELEGRAM_CHAT_ID,
                                          photo: imageUrl,
                                          caption: message,
                            }),
                }
                      );
              const photoData = await photoRes.json();
              if (photoData.ok) {
                        telegramSuccess = true;
              } else {
                        const textRes = await fetch(
                                    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                          {
                                        method: "POST",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
                          }
                                  );
                        const textData = await textRes.json();
                        if (textData.ok) telegramSuccess = true;
              }
      } else {
              const textRes = await fetch(
                        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
                {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
                }
                      );
              const textData = await textRes.json();
              if (textData.ok) telegramSuccess = true;
      }

      if (telegramSuccess) {
              postedIds.push(deal.id);
              if (postedIds.length > 500) postedIds = postedIds.slice(-500);
              await postedStore.set("posted-ids", JSON.stringify(postedIds));
              console.log(`Posted deal: ${deal.title}`);
      }

    } catch (err) {
          console.error("Error in post-deals-to-telegram:", err);
    }
}

export const config = {
    schedule: "*/10 * * * *",
};
