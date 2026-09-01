import { createHash } from "node:crypto";

const PENDING_PREFIX = "telegram-pending:";
const DONE_PREFIX = "telegram-done:";
const IMAGE_PREFIX = "telegram-image:";
const TELEGRAM_TIMEOUT_MS = 10_000;

function hashKey(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
}

function destinationKey(chatId) {
  return hashKey(`destination:${chatId}`);
}

function forwardKey(facebookPostId, dealId) {
  return hashKey(`facebook:${facebookPostId || "unknown"}|deal:${dealId || "unknown"}`);
}

export function parseTelegramDestinations(multiValue, fallbackValue) {
  const values = [];
  const add = (value) => {
    const normalized = String(value || "").trim();
    if (normalized && !values.includes(normalized)) values.push(normalized);
  };

  const raw = String(multiValue || "").trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) parsed.forEach(add);
      else add(parsed);
    } catch {
      raw.split(/[\n,;]+/).forEach(add);
    }
  }
  // A dedicated multi-destination value overrides the repository-wide legacy
  // chat ID. This lets the new automation be tested with exactly one private
  // destination without also posting to the existing production Telegram chat.
  if (values.length === 0) add(fallbackValue);
  return values;
}

export function telegramDestinationsFromEnv(env = process.env) {
  return parseTelegramDestinations(
    env.TELEGRAM_CHAT_IDS_DEALSAHOLIC2,
    env.TELEGRAM_CHAT_ID,
  );
}

export function buildTelegramCaption(deal) {
  const lines = [`🔥 ${deal.title}`];
  lines.push(`💰 Current price: ${deal.price}`);
  if (deal.originalPrice) lines.push(`🏷️ Original price: ${deal.originalPrice}`);
  if (deal.discountPercentage) lines.push(`📉 Discount: ${deal.discountPercentage}% off`);
  if (deal.promoCode) lines.push(`🎟️ Promo code: ${deal.promoCode}`);
  lines.push(`🔗 ${deal.affiliateUrl}`);
  lines.push("", "#ad");

  const caption = lines.join("\n");
  return caption.length <= 1024 ? caption : `${caption.slice(0, 1021)}...`;
}

async function sendPhoto({ botToken, chatId, imageBuffer, caption, fetchImpl }) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("photo", new Blob([imageBuffer], { type: "image/png" }), "deal.png");
  form.append("caption", caption);

  const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(data.description || `Telegram HTTP ${response.status}`);
  }
  return { messageId: data.result?.message_id || null };
}

async function completeForward(store, record, pendingKey, imageKey, doneKey) {
  await store.setJSON(doneKey, {
    facebookPostId: record.facebookPostId,
    dealId: record.dealId,
    completedAt: new Date().toISOString(),
    destinations: record.destinations,
  });
  await Promise.all([
    store.delete(pendingKey).catch(() => {}),
    store.delete(imageKey).catch(() => {}),
  ]);
}

async function attemptRecord({ store, record, pendingKey, imageKey, doneKey, botToken, destinations, imageBuffer, fetchImpl, log }) {
  const activeKeys = new Set(destinations.map(destinationKey));
  const nextDestinations = {};
  for (const chatId of destinations) {
    const key = destinationKey(chatId);
    nextDestinations[key] = record.destinations?.[key] || {
      chatId,
      status: "pending",
      attempts: 0,
    };
  }
  record.destinations = nextDestinations;
  record.updatedAt = new Date().toISOString();

  const attempts = Object.entries(record.destinations)
    .filter(([key, state]) => activeKeys.has(key) && state.status !== "success")
    .map(async ([key, state]) => {
      try {
        const sent = await sendPhoto({
          botToken,
          chatId: state.chatId,
          imageBuffer,
          caption: record.caption,
          fetchImpl,
        });
        record.destinations[key] = {
          ...state,
          status: "success",
          attempts: (state.attempts || 0) + 1,
          messageId: sent.messageId,
          sentAt: new Date().toISOString(),
          lastError: null,
        };
        log(`Telegram destination successful | destination=${state.chatId}`);
      } catch (error) {
        record.destinations[key] = {
          ...state,
          status: "failed",
          attempts: (state.attempts || 0) + 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: error.message,
        };
        log(`Telegram destination failed | destination=${state.chatId} | error=${error.message}`);
      }
    });

  await Promise.all(attempts);
  const allSuccessful = Object.values(record.destinations).length > 0 &&
    Object.values(record.destinations).every((state) => state.status === "success");

  if (allSuccessful) {
    await completeForward(store, record, pendingKey, imageKey, doneKey);
  } else {
    await store.setJSON(pendingKey, record);
  }

  return {
    ok: allSuccessful,
    destinations: record.destinations,
  };
}

export async function forwardSuccessfulFacebookPost({
  store,
  facebookPostId,
  dealId,
  deal,
  imageBuffer,
  botToken,
  destinations,
  fetchImpl = fetch,
  log = console.log,
}) {
  const key = forwardKey(facebookPostId, dealId);
  const pendingKey = `${PENDING_PREFIX}${key}`;
  const doneKey = `${DONE_PREFIX}${key}`;
  const imageKey = `${IMAGE_PREFIX}${key}`;

  if (await store.get(doneKey, { type: "json" }).catch(() => null)) {
    log(`Telegram duplicate skipped | facebookPostId=${facebookPostId} | dealId=${dealId}`);
    return { ok: true, duplicate: true };
  }

  let record = await store.get(pendingKey, { type: "json" }).catch(() => null);
  if (!record) {
    record = {
      facebookPostId,
      dealId,
      caption: buildTelegramCaption(deal),
      deal,
      destinations: {},
      createdAt: new Date().toISOString(),
    };
    await store.set(imageKey, imageBuffer, { metadata: { contentType: "image/png" } });
    await store.setJSON(pendingKey, record);
  }

  log(`Telegram forwarding started | facebookPostId=${facebookPostId} | dealId=${dealId}`);
  return attemptRecord({
    store,
    record,
    pendingKey,
    imageKey,
    doneKey,
    botToken,
    destinations,
    imageBuffer,
    fetchImpl,
    log,
  });
}

export async function retryPendingTelegramForwards({
  store,
  botToken,
  destinations,
  fetchImpl = fetch,
  log = console.log,
  limit = 3,
}) {
  const { blobs } = await store.list({ prefix: PENDING_PREFIX });
  const results = [];

  for (const blob of blobs.slice(0, limit)) {
    const pendingKey = blob.key;
    const key = pendingKey.slice(PENDING_PREFIX.length);
    const doneKey = `${DONE_PREFIX}${key}`;
    const imageKey = `${IMAGE_PREFIX}${key}`;

    if (await store.get(doneKey, { type: "json" }).catch(() => null)) {
      log(`Telegram duplicate skipped | pendingKey=${pendingKey}`);
      await store.delete(pendingKey).catch(() => {});
      continue;
    }

    const record = await store.get(pendingKey, { type: "json" }).catch(() => null);
    const rawImage = await store.get(imageKey, { type: "arrayBuffer" }).catch(() => null);
    if (!record || !rawImage) {
      log(`Telegram destination failed | pendingKey=${pendingKey} | error=missing retry data`);
      continue;
    }

    log(`Telegram forwarding started | retry=true | facebookPostId=${record.facebookPostId} | dealId=${record.dealId}`);
    results.push(await attemptRecord({
      store,
      record,
      pendingKey,
      imageKey,
      doneKey,
      botToken,
      destinations,
      imageBuffer: Buffer.from(rawImage),
      fetchImpl,
      log,
    }));
  }

  return results;
}
