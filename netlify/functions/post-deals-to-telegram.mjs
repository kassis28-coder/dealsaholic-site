import { getStore } from "@netlify/blobs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CONCURRENCY = 20;
const RATE_LIMIT_DELAY_MS = 500;
const MAX_POSTED_IDS = 1000;

// ── Caption builder ──────────────────────────────────────────────────────────

function buildCaption(deal) {
  const header = Math.random() > 0.5 ? "🔥 Deal Alert!" : "⚡ Limited Time Deal!";
  const lines = [header, "", `🛍️ ${deal.title}`, ""];

  if (deal.price)         lines.push(`💰 Price: ${deal.price}`);
  if (deal.originalPrice) lines.push(`🏷️ Was: ${deal.originalPrice}`);
  if (deal.discount)      lines.push(`🔥 Save ${deal.discount}%`);
  if (deal.discountCode)  lines.push(`🎟️ Promo Code: ${deal.discountCode}`);

  lines.push("", `👉 ${deal.url}`, "");
  lines.push("🔔 More deals at https://deals-aholic.com");
  lines.push("⚠️ Price valid at time of posting. #ad");

  const text = lines.join("\n");
  return text.length > 1024 ? text.substring(0, 1021) + "..." : text;
}

// ── Telegram sender ──────────────────────────────────────────────────────────

async function sendDeal(deal) {
  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  const caption = buildCaption(deal);
  const imageUrl = deal.imageUrl || deal.image || null;

  if (imageUrl) {
    try {
      const res = await fetch(`${base}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, photo: imageUrl, caption }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log(`[TG] sendPhoto OK | "${deal.title.substring(0, 60)}"`);
        return { ok: true };
      }
      console.warn(`[TG] sendPhoto failed (${data.error_code}): ${data.description} — falling back to text`);
      if (data.error_code === 403) return { ok: false, error: `(403) ${data.description}`, fatal: true };
    } catch (e) {
      console.warn(`[TG] sendPhoto threw: ${e.message} — falling back to text`);
    }
  }

  const res = await fetch(`${base}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: caption }),
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

// ── Load eligible deals from submissions store ───────────────────────────────

async function loadEligibleDeals(submissionsStore, postedIds) {
  let index = [];
  try {
    const stored = await submissionsStore.get("index", { type: "json" });
    if (Array.isArray(stored)) index = stored;
  } catch (e) {
    throw new Error("Failed to read submissions index: " + e.message);
  }
  console.log(`[TG] Index has ${index.length} deal IDs`);

  const now = Date.now();
  const eligible = [];
  let skippedPending = 0, skippedPosted = 0, skippedExpired = 0, skippedEmpty = 0;

  for (let i = 0; i < index.length; i += CONCURRENCY) {
    const batch = index.slice(i, i + CONCURRENCY);
    const records = await Promise.all(
      batch.map(id => submissionsStore.get(id, { type: "json" }).catch(() => null))
    );
    for (const deal of records) {
      if (!deal?.id || !deal.title || !deal.url) { skippedEmpty++;   continue; }
      if (deal.status !== "approved")             { skippedPending++; continue; }
      if (postedIds.includes(deal.id))            { skippedPosted++;  continue; }
      if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) { skippedExpired++; continue; }
      eligible.push(deal);
    }
  }

  console.log(
    `[TG] Eligible: ${eligible.length} | ` +
    `skipped pending=${skippedPending} posted=${skippedPosted} expired=${skippedExpired} empty=${skippedEmpty}`
  );
  return eligible;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export default async () => {
  console.log("[TG] Scheduler triggered (post-deals-to-telegram)");

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("[TG] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return new Response(
      JSON.stringify({ success: false, error: "Missing Telegram credentials" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  const submissionsStore = getStore("submissions");
  const postedStore = getStore("telegram-posted");

  let postedIds = [];
  try {
    const stored = await postedStore.get("posted-ids", { type: "json" });
    if (Array.isArray(stored)) postedIds = stored;
  } catch {
    console.log("[TG] No posted-ids yet — starting fresh");
  }
  console.log(`[TG] Already posted: ${postedIds.length} deals`);

  let eligible;
  try {
    eligible = await loadEligibleDeals(submissionsStore, postedIds);
  } catch (e) {
    return new Response(
      JSON.stringify({ success: false, error: e.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  if (eligible.length === 0) {
    console.log("[TG] No new deals to post");
    return new Response(
      JSON.stringify({ success: true, posted: 0 }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  let posted = 0, failed = 0;
  const errors = [];

  for (const deal of eligible) {
    const result = await sendDeal(deal);
    if (result.ok) {
      postedIds.push(deal.id);
      posted++;
    } else {
      failed++;
      errors.push({ id: deal.id, error: result.error });
      if (result.fatal) {
        console.error("[TG] Fatal error — stopping. Make sure bot is an admin in the channel.");
        break;
      }
    }
    if (eligible.length > 1) await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY_MS));
  }

  if (posted > 0) {
    if (postedIds.length > MAX_POSTED_IDS) postedIds = postedIds.slice(-MAX_POSTED_IDS);
    await postedStore.set("posted-ids", JSON.stringify(postedIds));
    console.log(`[TG] Saved posted-ids | total: ${postedIds.length}`);
  }

  console.log(`[TG] Done | posted=${posted} failed=${failed}`);
  return new Response(
    JSON.stringify({ success: true, posted, failed, errors }),
    { headers: { "Content-Type": "application/json" } }
  );
};

// Every 3 hours
export const config = { schedule: "0 */3 * * *" };
