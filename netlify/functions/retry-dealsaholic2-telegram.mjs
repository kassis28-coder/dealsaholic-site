import { getStore } from "@netlify/blobs";
import {
  retryPendingTelegramForwards,
  telegramDestinationsFromEnv,
} from "./lib/dealsaholic2-telegram-forwarding.mjs";

const TAG = "[dealsaholic2-telegram-retry]";

export default async function handler() {
  const log = (...args) => console.log(TAG, ...args);
  if (process.env.TELEGRAM_FORWARDING_ENABLED_DEALSAHOLIC2 !== "true") {
    return new Response(JSON.stringify({ ok: true, reason: "disabled" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const destinations = telegramDestinationsFromEnv();
  if (!botToken || destinations.length === 0) {
    log("Telegram destination failed | error=missing Telegram configuration");
    return new Response(JSON.stringify({ ok: false, reason: "missing_configuration" }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore("facebook-image-posts-dealsaholic2");
  const results = await retryPendingTelegramForwards({
    store,
    botToken,
    destinations,
    log,
  });

  return new Response(JSON.stringify({ ok: true, retried: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
}

export const config = {
  schedule: "*/10 * * * *",
};

