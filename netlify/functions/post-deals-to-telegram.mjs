import { getStore } from "@netlify/blobs";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Post a single message to Telegram â photo with caption if image available,
// plain text otherwise. Returns { ok, error }.
async function sendToTelegram(imageUrl, message) {
  const base = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
  // Telegram photo captions are limited to 1024 characters
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
        console.log(`[TELEGRAM] â sendPhoto success | message_id:${data.result?.message_id}`);
        return { ok: true };
      }
      console.warn(`[TELEGRAM] sendPhoto failed (${data.error_code}): ${data.description} â falling back to text`);
    } catch (e) {
      console.warn(`[TELEGRAM] sendPhoto threw: ${e.message} â falling back to text`);
    }
  }

  // Fallback: send as plain text
  console.log(`[TELEGRAM] Sending text message (length: ${message.length})`);
  try {
    const res = await fetch(`${base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log(`[TELEGRAM] â sendMessage success | message_id:${data.result?.message_id}`);
      return { ok: true };
    }
    const err = `(${data.error_code}) ${data.description}`;
    console.error(`[TELEGRAM] â sendMessage failed: ${err}`);
    return { ok: false, error: err };
  } catch (e) {
    console.error(`[TELEGRAM] â sendMessage threw: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

export default async () => {
  console.log('[TELEGRAM] â¶ Scheduler triggered (post-deals-to-telegram)');

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[TELEGRAM] â Missing env vars: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return new Response(
      JSON.stringify({ success: false, error: 'Missing Telegram credentials' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const submissionsStore = getStore('submissions');
  const postedStore = getStore('telegram-posted');

  // Load posted-IDs to avoid re-posting
  let postedIds = [];
  try {
    const stored = await postedStore.get('posted-ids', { type: 'json' });
    if (Array.isArray(stored)) postedIds = stored;
  } catch {
    console.log('[TELEGRAM] No posted-ids found â starting fresh');
  }
  console.log(`[TELEGRAM] Already-posted IDs: ${postedIds.length}`);

  // List all blobs in the submissions store
  let blobs = [];
  try {
    ({ blobs } = await submissionsStore.list());
  } catch (e) {
    console.error('[TELEGRAM] â Failed to list submissions:', e.message);
    return new Response(
      JSON.stringify({ success: false, error: 'Failed to list submissions' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
  console.log(`[TELEGRAM] Total blobs in submissions: ${blobs.length}`);

  const now = Date.now();
  const eligible = [];
  let skippedPending = 0, skippedPosted = 0, skippedExpired = 0, skippedEmpty = 0;

  for (const blob of blobs) {
    try {
      const deal = await submissionsStore.get(blob.key, { type: 'json' });
      if (!deal || !deal.id) { skippedEmpty++; continue; }
      if (deal.status !== 'approved') { skippedPending++; continue; }
      if (postedIds.includes(deal.id)) { skippedPosted++; continue; }
      if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) { skippedExpired++; continue; }
      if (!deal.title || !deal.url) { skippedEmpty++; continue; }
      eligible.push(deal);
    } catch (e) {
      console.log(`[TELEGRAM] Error reading blob ${blob.key}: ${e.message}`);
    }
  }

  console.log(
    `[TELEGRAM] Eligible: ${eligible.length} | ` +
    `skipped pending=${skippedPending} posted=${skippedPosted} expired=${skippedExpired} empty=${skippedEmpty}`
  );

  if (eligible.length === 0) {
    console.log('[TELEGRAM] No eligible deals â nothing to post');
    return new Response(
      JSON.stringify({ success: true, message: 'No eligible deals', skipped: { skippedPending, skippedPosted, skippedExpired, skippedEmpty } }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Post the newest eligible deal
  eligible.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const deal = eligible[0];
  console.log(`[TELEGRAM] Posting: "${deal.title.substring(0, 80)}" | id:${deal.id} | image:${deal.imageUrl ? 'YES' : 'no'}`);

  // Build message
  const lines = [deal.title];
  if (deal.discount) lines.push(`ð¥ ${deal.discount}% OFF`);
  if (deal.price) lines.push(`ð° Price: ${deal.price}`);
  if (deal.discountCode) lines.push(`ð·ï¸ Promo Code: ${deal.discountCode}`);
  lines.push('');
  lines.push(`ð Get it here: ${deal.url}`);
  lines.push('');
  lines.push('@dealsaholic');
  const message = lines.join('\n');

  const imageUrl = deal.imageUrl || deal.image || null;
  const result = await sendToTelegram(imageUrl, message);

  if (result.ok) {
    postedIds.push(deal.id);
    if (postedIds.length > 500) postedIds = postedIds.slice(-500);
    await postedStore.setJSON('posted-ids', postedIds);
    console.log(`[TELEGRAM] â Marked as posted | total posted: ${postedIds.length}`);
  } else {
    console.error(`[TELEGRAM] â Post failed â deal NOT marked as posted | error: ${result.error}`);
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
