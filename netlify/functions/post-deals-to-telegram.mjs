import { getStore } from "@netlify/blobs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendToTelegram(imageUrl, message) {
  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  const caption = message.length > 1024 ? message.substring(0, 1021) + '...' : message;

  if (imageUrl) {
    console.log(`[TELEGRAM] Attempting sendPhoto | image: ${imageUrl.substring(0, 80)}`);
    try {
      const res = await fetch(`${base}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, photo: imageUrl, caption }),
      });
      const data = await res.json();
      if (data.ok) {
        console.log(`[TELEGRAM] sendPhoto success | message_id:${data.result?.message_id}`);
        return { ok: true };
      }
      console.warn(`[TELEGRAM] sendPhoto failed (${data.error_code}): ${data.description} - falling back to text`);
    } catch (e) {
      console.warn(`[TELEGRAM] sendPhoto threw: ${e.message} - falling back to text`);
    }
  }

  console.log(`[TELEGRAM] Sending text message (length: ${message.length})`);
  try {
    const res = await fetch(`${base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[TELEGRAM] sendMessage success | message_id:${data.result?.message_id}`);
      return { ok: true };
    }
    const err = `(${data.error_code}) ${data.description}`;
    console.error(`[TELEGRAM] sendMessage failed: ${err}`);
    return { ok: false, error: err };
  } catch (e) {
    console.error(`[TELEGRAM] sendMessage threw: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export default async () => {
  console.log('[TELEGRAM] Scheduler triggered (post-deals-to-telegram)');

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[TELEGRAM] Missing env vars: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return new Response(
      JSON.stringify({ success: false, error: 'Missing Telegram credentials' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const submissionsStore = getStore('submissions');
  const postedStore = getStore('telegram-posted');

  let postedIds = [];
  try {
    const stored = await postedStore.get('posted-ids', { type: 'json' });
    if (Array.isArray(stored)) postedIds = stored;
  } catch {
    console.log('[TELEGRAM] No posted-ids found - starting fresh');
  }
  console.log(`[TELEGRAM] Already-posted IDs: ${postedIds.length}`);

  // Use index blob (newest first) instead of listing all 1000+ blobs sequentially
  let index = [];
  try {
    const stored = await submissionsStore.get('index', { type: 'json' });
    if (Array.isArray(stored)) index = stored;
  } catch (e) {
    console.error('[TELEGRAM] Failed to read index:', e.message);
    return new Response(
      JSON.stringify({ success: false, error: 'Failed to read submissions index' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  console.log(`[TELEGRAM] Index has ${index.length} deal IDs`);

  // Fetch in parallel batches, stop as soon as we find one eligible deal
  const now = Date.now();
  const CONCURRENCY = 20;
  let eligible = null;
  let skippedPending = 0, skippedPosted = 0, skippedExpired = 0, skippedEmpty = 0;

  outer:
  for (let i = 0; i < index.length; i += CONCURRENCY) {
    const batch = index.slice(i, i + CONCURRENCY);
    const records = await Promise.all(
      batch.map(id => submissionsStore.get(id, { type: 'json' }).catch(() => null))
    );

    for (const deal of records) {
      if (!deal || !deal.id || !deal.title || !deal.url) { skippedEmpty++; continue; }
      if (deal.status !== 'approved') { skippedPending++; continue; }
      if (postedIds.includes(deal.id)) { skippedPosted++; continue; }
      if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) { skippedExpired++; continue; }
      eligible = deal;
      break outer;
    }
  }

  console.log(
    `[TELEGRAM] Eligible: ${eligible ? 1 : 0} | ` +
    `skipped pending=${skippedPending} posted=${skippedPosted} expired=${skippedExpired} empty=${skippedEmpty}`
  );

  if (!eligible) {
    console.log('[TELEGRAM] No eligible deals - nothing to post');
    return new Response(
      JSON.stringify({ success: true, message: 'No eligible deals', skipped: { skippedPending, skippedPosted, skippedExpired, skippedEmpty } }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  const deal = eligible;
  console.log(`[TELEGRAM] Posting: "${deal.title.substring(0, 80)}" | id:${deal.id}`);

  const lines = [deal.title];
  if (deal.discount) lines.push(`🔥 ${deal.discount}% OFF`);
  if (deal.price) lines.push(`💰 Price: ${deal.price}`);
  if (deal.discountCode) lines.push(`🏷️ Promo Code: ${deal.discountCode}`);
  lines.push('');
  lines.push(`👉 Get it here: ${deal.url}`);
  lines.push('');
  lines.push('@dealsaholic');
  const message = lines.join('\n');

  const imageUrl = deal.imageUrl || deal.image || null;
  const result = await sendToTelegram(imageUrl, message);

  if (result.ok) {
    postedIds.push(deal.id);
    if (postedIds.length > 500) postedIds = postedIds.slice(-500);
    await postedStore.set('posted-ids', JSON.stringify(postedIds));
    console.log(`[TELEGRAM] Marked as posted | total posted: ${postedIds.length}`);
  } else {
    console.error(`[TELEGRAM] Post failed - deal NOT marked as posted | error: ${result.error}`);
  }

  return new Response(
    JSON.stringify({
      success: result.ok,
      dealId: deal.id,
      title: deal.title.substring(0, 100),
      error: result.error || null,
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};

export const config = { schedule: '*/10 * * * *' };
