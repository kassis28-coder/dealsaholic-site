import { getStore } from "@netlify/blobs";

// Telegram caption limit for sendPhoto is 1024 chars
function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 3) + '...';
}

// ── Telegram API call ──────────────────────────────────────────────────

async function postToTelegram(deal) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars');
  }

  const titleLine = deal.title ? `<b^${deal.title}</b>` : '🛍️ <b>Amazon Deal</b>';
  const priceLine = deal.price ? `💐 <b>${deal.price}</b>` : '';
  const promoLine = deal.promoCode ? `🎟 Code: <code>${deal.promoCode}</code>` : '';
  const linkLine = deal.url ? `🔗 <a href="${deal.url}">Grab this deal!</a>` : '';
  const caption = truncate(
    [titleLine, priceLine, promoLine, linkLine].filter(Boolean).join('\n\n'),
    1024
  );

  const imageUrl = deal.imageUrl || null;
  const baseUrl = `https://api.telegram.org/bot${token}`;

  if (imageUrl) {
    const res = await fetch(`${baseUrl}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: imageUrl,
        caption,
        parse_mode: 'HTML',
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`TG API error: ${JSON.stringify(data)}`);
    return { messageId: data.result?.message_id };
  } else {
    // Fallback: send text message
    const textCaption = truncate(
      [deal.title || 'Amazon Deal', deal.price, deal.url].filter(Boolean).join('\n'),
      4096
    );
    const res = await fetch(`${baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: textCaption,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`TG API error: ${JSON.stringify(data)}`);
    return { messageId: data.result?.message_id };
  }
}

// ── Main scheduled handler ───────────────────────────────────────────────────

export default async (_req, _context) => {
  const submissionsStore = getStore('submissions');

  // 1. Load the index of all deal IDs
  let index = [];
  try {
    index = (await submissionsStore.get('index', { type: 'json' })) || [];
  } catch {
    index = [];
  }

  if (index.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'No deals in index' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Find the first approved, unposted-to-Telegram deal
  let targetDeal = null;
  let targetId = null;

  for (const id of index) {
    let deal = null;
    try {
      deal = await submissionsStore.get(id, { type: 'json' });
    } catch {
      continue;
    }
    if (!deal) continue;
    if (deal.status !== 'approved') continue;
    if (deal.telegramPosted === true) continue;
    if (!deal.url) continue;

    targetDeal = deal;
    targetId = id;
    break;
  }

  if (!targetDeal) {
    return new Response(JSON.stringify({ success: true, message: 'No unposted deals found' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Post to Telegram
  let tgResult;
  try {
    tgResult = await postToTelegram(targetDeal);
  } catch (err) {
    console.error('[post-deals-to-telegram] TG API error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 4. Mark the deal as posted — save back to submissions store
  const updatedDeal = {
    ...targetDeal,
    telegramPosted: true,
    telegramPostedAt: new Date().toISOString(),
    telegramMessageId: tgResult.messageId || null,
  };
  await submissionsStore.setJSON(targetId, updatedDeal);

  console.log(`[post-deals-to-telegram] Posted deal ${targetId}: ${targetDeal.title}`);

  return new Response(
    JSON.stringify({
      success: true,
      dealId: targetId,
      title: targetDeal.title,
      telegramMessageId: tgResult.messageId || null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export const config = { schedule: '*/10 * * * *' };
