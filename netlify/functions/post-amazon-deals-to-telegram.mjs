import { getStore } from "@netlify/blobs";

const LOCK_STALE_MS = 30 * 60 * 1000;

// ── Expiry formatter ─────────────────────────────────────────────────────────

function formatExpiry(isoString) {
  if (!isoString) return null;

  try {
    const d = new Date(isoString);
    return d.toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/New_York",
    });
  } catch {
    return null;
  }
}

// ── Caption builder ─────────────────────────────────────────────────────────

function buildCaption(deal) {
  const lines = [];

  // Alternate style
  const style = Math.random() > 0.5
    ? "🔥 Amazon Deal Alert"
    : "⚡ Limited Time Deal";

  lines.push(style);
  lines.push("");

  lines.push(`🛍️ <b>${deal.title}</b>`);
  lines.push(`💰 Price: <b>${deal.price || "N/A"}</b>`);

  if (deal.originalPrice) {
    lines.push(`🏷️ Was: ${deal.originalPrice}`);
  }

  if (deal.discountPercent) {
    lines.push(`🔥 Save ${deal.discountPercent}%`);
  }

  if (deal.discountCode) {
    lines.push(`🎟️ Promo Code: <code>${deal.discountCode}</code>`);
  }

  lines.push("");
  lines.push(`🔗 <a href="${deal.url}">Grab this deal!</a>`);

  const expiry = formatExpiry(deal.expiresOn);
  if (expiry) {
    lines.push(`⏰ Expires: ${expiry}`);
  }

  lines.push("");
  lines.push("⚠️ Price valid at the time posted but may change at any time.");
  lines.push("#ad");

  return lines.join("\n");
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateDeal(deal) {
  const errors = [];

  if (!deal.title) errors.push("missing title");
  if (!deal.price) errors.push("missing price");
  if (!deal.url) errors.push("missing url");

  return errors;
}

// ── Telegram post ───────────────────────────────────────────────────────────

async function postToTelegram(deal) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  }

  const caption = buildCaption(deal);
  const baseUrl = `https://api.telegram.org/bot${token}`;

  if (deal.image) {
    const res = await fetch(`${baseUrl}/sendPhoto`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        photo: deal.image,
        caption,
        parse_mode: "HTML",
      }),
    });

    const data = await res.json();

    if (!data.ok) {
      throw new Error(JSON.stringify(data));
    }

    return data.result.message_id;
  }

  const res = await fetch(`${baseUrl}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });

  const data = await res.json();

  if (!data.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data.result.message_id;
}


// ── Main ─────────────────────────────────────────────────────────────────────

export default async () => {

  const TAG = "[post-amazon-deals-to-telegram]";

  const store = getStore("deals");

  let latest;

  try {
    latest = await store.get("latest", { type: "json" });
  } catch {
    latest = null;
  }

  if (!latest || !Array.isArray(latest.deals)) {
    return new Response(JSON.stringify({
      success: true,
      message: "No deals available"
    }), {
      headers: {
        "Content-Type": "application/json"
      }
    });
  }


  let targetDeal = null;


  for (const deal of latest.deals) {

    if (!deal) continue;

    if (deal.telegramPosted === true) continue;

    if (!deal.url) continue;


    if (
      deal.telegramProcessing === true &&
      Date.now() -
      new Date(deal.telegramProcessingStarted || 0).getTime()
      <
      LOCK_STALE_MS
    ) {
      continue;
    }


    targetDeal = deal;
    break;
  }


  if (!targetDeal) {

    return new Response(JSON.stringify({
      success: true,
      message: "No unposted deals found"
    }), {
      headers:{
        "Content-Type":"application/json"
      }
    });

  }


  const errors = validateDeal(targetDeal);


  if (errors.length) {

    console.log(
      `${TAG} skipped ${errors.join(", ")}`
    );

    return new Response(JSON.stringify({
      success:false,
      error:errors
    }), {
      headers:{
        "Content-Type":"application/json"
      }
    });

  }


  try {

    const messageId = await postToTelegram(targetDeal);


    targetDeal.telegramPosted = true;
    targetDeal.telegramPostedAt = new Date().toISOString();
    targetDeal.telegramMessageId = messageId;


    // Save updated list
    const updated = latest.deals.map(d =>
      d.asin === targetDeal.asin ? targetDeal : d
    );


    await store.setJSON("latest", {
      ...latest,
      deals: updated
    });


    return new Response(JSON.stringify({
      success:true,
      title:targetDeal.title,
      telegramMessageId:messageId
    }),{
      headers:{
        "Content-Type":"application/json"
      }
    });


  } catch(err){

    console.error(TAG, err.message);

    return new Response(JSON.stringify({
      success:false,
      error:err.message
    }),{
      status:500,
      headers:{
        "Content-Type":"application/json"
      }
    });

  }

};


export const config = {
  schedule:"*/0 * * * *"
};
