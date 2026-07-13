import { getStore } from "@netlify/blobs";

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 3) + '...';
}

function formatExpiry(isoString) {
  if (!isoString) return null;
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
      timeZone: 'America/New_York',
    });
  } catch {
    return null;
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateDeal(deal) {
  const errors = [];
  if (!deal.title) errors.push('missing title');
  if (!deal.price) errors.push('missing price');
  if (!deal.url)   errors.push('missing url');
  return errors;
}

// ── Telegram API call — reads ONLY from DB fields ────────────────────────────

async function postToTelegram(deal) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');

  const lines = [];
  lines.push(`🛍️ <b>${deal.title}</b>`);
  lines.push(`💰 Deal Price: <b>${deal.price}</b>`);
  if (deal.originalPrice) lines.push(`🏷️ Original Price: ${deal.originalPrice}`);
  if (deal.discount)      lines.push(`🔥 Save ${deal.discount}%`);
  if (deal.discountCode)  lines.push(`🎟️ Promo Code: <code>${deal.discountCode}</code>`);
  lines.push(`🔗 <a href="${deal.url}">Grab this deal!</a>`);
  const expiry = formatExpiry(deal.expiresOn);
  if (expiry) lines.push(`⏰ Expires: ${expiry}`);
  lines.push('\n#ad');

  const imageUrl = deal.imageUrl || null;
  const baseUrl  = `https://api.telegram.org/bot${token}`;

  if (imageUrl) {
    const caption = truncate(lines.join('\n'), 1024);
    const res  = await fetch(`${baseUrl}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: imageUrl, caption, parse_mode: 'HTML' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`TG API error: ${JSON.stringify(data)}`);
    return { messageId: data.result?.message_id };
  } else {
    const text = truncate(lines.join('\n'), 4096);
    const res  = await fetch(`${baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: false }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`TG API error: ${JSON.stringify(data)}`);
    return { messageId: data.result?.message_id };
  }
}

// ── Main scheduled handler ───────────────────────────────────────────────────

export default async (_req, _context) => {
  const submissionsStore = getStore('submissions');

  let index = [];
  try { index = (await submissionsStore.get('index', { type: 'json' })) || []; } catch { index = []; }

  if (index.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'No deals in index' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Find first approved deal not yet posted to Telegram
  let targetDeal = null;
  let targetId   = null;

  for (const id of index) {
    let deal = null;
    try { deal = await submissionsStore.get(id, { type: 'json' }); } catch { continue; }
    if (!deal) continue;
    if (deal.status !== 'approved') continue;
    if (deal.telegramPosted === true) continue;
    if (!deal.url) continue;
    targetDeal = deal;
    targetId   = id;
    break;
  }

  if (!targetDeal) {
    return new Response(JSON.stringify({ success: true, message: 'No unposted deals found' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate — skip and mark done if required fields are missing
  const errors = validateDeal(targetDeal);
  if (errors.length > 0) {
    console.error(`[post-deals-to-telegram] Skipping deal ${targetId}: ${errors.join(', ')}`);
    await submissionsStore.setJSON(targetId, {
      ...targetDeal,
      telegramPosted: true,
      telegramSkipped: true,
      telegramSkipReason: errors.join(', '),
      telegramPostedAt: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ success: false, skipped: true, reason: errors.join(', ') }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Post to Telegram
  let tgResult;
  try {
    tgResult = await postToTelegram(targetDeal);
  } catch (err) {
    console.error('[post-deals-to-telegram] TG API error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Mark posted
  await submissionsStore.setJSON(targetId, {
    ...targetDeal,
    telegramPosted: true,
    telegramPostedAt: new Date().toISOString(),
    telegramMessageId: tgResult.messageId || null,
  });

  console.log(`[post-deals-to-telegram] Posted deal ${targetId}: ${targetDeal.title}`);

  return new Response(
    JSON.stringify({ success: true, dealId: targetId, title: targetDeal.title, telegramMessageId: tgResult.messageId || null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export const config = { schedule: '*/30 * * * *' };
