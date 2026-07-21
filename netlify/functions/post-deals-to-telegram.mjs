import { getStore } from "@netlify/blobs";

const LOCK_STALE_MS = 5 * 60 * 1000;

function buildCaption(deal) {
  const lines = [];
  lines.push(`🛍️ ${deal.title}`);
  lines.push(`💰 Deal Price: ${deal.price}`);
  if (deal.originalPrice) lines.push(`🏷️ Original Price: ${deal.originalPrice}`);
  if (deal.discount)      lines.push(`🔥 Save ${deal.discount}%`);
  lines.push(`🎟️ Promo Code: ${deal.discountCode || 'None'}`);
  lines.push(`🔗 ${deal.url}`);
  lines.push("\n#ad");
  const text = lines.join("\n");
  return text.length > 1024 ? text.substring(0, 1021) + "..." : text;
}

function validateDeal(deal) {
  const errors = [];
  if (!deal.title)    errors.push("missing title");
  if (!deal.price)    errors.push("missing price");
  if (!deal.url)      errors.push("missing url");
  return errors;
}

async function postToTelegram(deal, botToken, chatId) {
  const base = `https://api.telegram.org/bot${botToken}`;
  const caption = buildCaption(deal);
  const imageUrl = deal.imageUrl || deal.image || null;

  if (imageUrl) {
    const res = await fetch(`${base}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, photo: imageUrl, caption }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[TG] sendPhoto OK | "${deal.title.substring(0, 60)}"`);
      return { ok: true };
    }
    console.warn(`[TG] sendPhoto failed (${data.error_code}): ${data.description} — falling back to text`);
    if (data.error_code === 403) return { ok: false, error: `(403) ${data.description}`, fatal: true };
  }

  const res = await fetch(`${base}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: caption }),
  });
  const data = await res.json();
  if (data.ok) {
    console.log(`[TG] sendMessage OK | "${deal.title.substring(0, 60)}"`);
    return { ok: true };
  }
  const err = `(${data.error_code}) ${data.description}`;
  console.error(`[TG] sendMessage failed: ${err}`);
  return { ok: false, error: err, fatal: data.error_code === 403 };
}

export default async (_req, _context) => {
  const TAG = "[post-to-telegram]";
  const store = getStore("submissions");
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    console.error(`${TAG} ABORT: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars`);
    return new Response(
      JSON.stringify({ success: false, error: "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  let index = [];
  try { index = (await store.get("index", { type: "json" })) || []; } catch { index = []; }
  console.log(`${TAG} Index loaded. Total deals: ${index.length}`);

  if (index.length === 0) {
    return new Response(
      JSON.stringify({ success: true, message: "No deals in index" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  let targetDeal = null;
  let targetId   = null;

  for (const id of index) {
    let deal = null;
    try { deal = await store.get(id, { type: "json" }); } catch { continue; }
    if (!deal) continue;
    if (deal.status !== "approved") continue;
    if (deal.telegramPosted === true) continue;
    if (deal.telegramProcessing === true) {
      const startedAt = new Date(deal.telegramProcessingStarted || 0).getTime();
      const ageMs = Date.now() - startedAt;
      if (ageMs < LOCK_STALE_MS) {
        console.log(`${TAG} Deal ${id} skipped — locked ${Math.round(ageMs / 1000)}s ago`);
        continue;
      }
      console.warn(`${TAG} Deal ${id} — stale lock (${Math.round(ageMs / 60000)} min). Clearing.`);
    }
    if (!deal.url) continue;
    targetDeal = deal;
    targetId   = id;
    break;
  }

  if (!targetDeal) {
    console.log(`${TAG} No unposted deals available.`);
    return new Response(
      JSON.stringify({ success: true, message: "No unposted deals found" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  console.log(`${TAG} Selected: ${targetId} | ${targetDeal.title}`);
  await store.setJSON(targetId, {
    ...targetDeal,
    telegramProcessing: true,
    telegramProcessingStarted: new Date().toISOString(),
  });

  const errors = validateDeal(targetDeal);
  if (errors.length > 0) {
    console.error(`${TAG} Validation failed: ${errors.join(", ")} — skipping.`);
    await store.setJSON(targetId, {
      ...targetDeal,
      telegramPosted: true,
      telegramProcessing: false,
      telegramSkipped: true,
      telegramSkipReason: errors.join(", "),
      telegramPostedAt: new Date().toISOString(),
    });
    return new Response(
      JSON.stringify({ success: false, skipped: true, reason: errors.join(", ") }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  let tgResult;
  try {
    tgResult = await postToTelegram(targetDeal, botToken, chatId);
  } catch (err) {
    console.error(`${TAG} Exception posting deal ${targetId}: ${err.message}`);
    await store.setJSON(targetId, {
      ...targetDeal,
      telegramProcessing: false,
      telegramLastError: err.message,
      telegramLastAttempt: new Date().toISOString(),
    });
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (tgResult.ok) {
    console.log(`${TAG} Success. Marking telegramPosted=true for ${targetId}`);
    await store.setJSON(targetId, {
      ...targetDeal,
      telegramPosted: true,
      telegramProcessing: false,
      telegramPostedAt: new Date().toISOString(),
    });
    return new Response(
      JSON.stringify({ success: true, dealId: targetId, title: targetDeal.title }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  console.error(`${TAG} Post failed: ${tgResult.error}`);
  await store.setJSON(targetId, {
    ...targetDeal,
    telegramProcessing: false,
    telegramLastError: tgResult.error,
    telegramLastAttempt: new Date().toISOString(),
  });
  return new Response(
    JSON.stringify({ success: false, error: tgResult.error }),
    { status: tgResult.fatal ? 500 : 200, headers: { "Content-Type": "application/json" } }
  );
};

// One deal per run, every 5 minutes — mirrors post-to-facebook.mjs
export const config = { schedule: "*/5 * * * *" };
