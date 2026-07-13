cimportc{ getStore } from "@netlify/blobs";

// Stale lock timeout: if facebookProcessing=true but started >30 min ago,
// the previous run crashed — treat as stale and clear the lock.
const LOCK_STALE_MS = 30 * 60 * 1000;

// ── Expiry formatter ─────────────────────────────────────────────────────────

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

// ── Caption builder — reads ONLY from DB fields ──────────────────────────────

function buildCaption(deal) {
  const lines = [];
  lines.push(`🛍️ ${deal.title}`);
  lines.push(`💰 Deal Price: ${deal.price}`);
  if (deal.originalPrice) lines.push(`🏷️ Original Price: ${deal.originalPrice}`);
  if (deal.discount)      lines.push(`🔥 Save ${deal.discount}%`);
  lines.push(`🎟️ Promo Code: ${deal.discountCode || 'None'}`);
  lines.push(`🔗 ${deal.url}`);
  const expiry = formatExpiry(deal.expiresOn);
  if (expiry) lines.push(`⏰ Expires: ${expiry}`);
  lines.push('\n#ad');
  return lines.join('\n');
}

// ── Validation ───────────────────────────────────────────────────────────────

function validateDeal(deal) {
  const errors = [];
  if (!deal.title)    errors.push('missing title');
  if (!deal.price)    errors.push('missing price');
  if (!deal.url)      errors.push('missing url');
  if (!deal.imageUrl) errors.push('missing imageUrl');
  return errors;
}

// ── Deduplication: compare DB deal against live Facebook page posts ──────────

async function isAlreadyPostedOnFacebook(deal, pageId, token) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/${pageId}/posts?fields=message&limit=50&access_token=${token}`
    );
    const data = await res.json();
    if (!data.data || !Array.isArray(data.data)) return false;
    return data.data.some(post => {
      const msg = post.message || '';
      return (deal.url && msg.includes(deal.url)) ||
             (deal.title && msg.includes(deal.title));
    });
  } catch (err) {
    console.warn('[post-to-facebook] FB dedup check failed (non-blocking):', err.message);
    return false;
  }
}

// ── Facebook Graph API call ──────────────────────────────────────────────────

async function postToFacebook(deal, pageId, token) {
  const caption  = buildCaption(deal);
  const imageUrl = deal.imageUrl;

  if (imageUrl) {
    const params = new URLSearchParams({ url: imageUrl, caption, access_token: token, published: 'true' });
    const res  = await fetch(`https://graph.facebook.com/${pageId}/photos`, { method: 'POST', body: params });
    const data = await res.json();
    if (!res.ok) throw new Error(`FB API error: ${JSON.stringify(data)}`);
    return { id: data.id, post_id: data.post_id };
  } else {
    const params = new URLSearchParams({ message: caption, access_token: token });
    const res  = await fetch(`https://graph.facebook.com/${pageId}/feed`, { method: 'POST', body: params });
    const data = await res.json();
    if (!res.ok) throw new Error(`FB API error: ${JSON.stringify(data)}`);
    return { id: data.id };
  }
}

// ── Main scheduled handler ───────────────────────────────────────────────────

export default async (_req, _context) => {
  const TAG   = '[post-to-facebook]';
  const store = getStore('submissions');
  const pageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  const token  = process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;

  if (!pageId || !token) {
    console.error(`${TAG} ABORT: Missing FB_PAGE_ID or FB_PAGE_TOKEN env vars`);
    return new Response(JSON.stringify({ success: false, error: 'Missing FB_PAGE_ID or FB_PAGE_TOKEN' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 1: Load index ───────────────────────────────────────────────────
  let index = [];
  try { index = (await store.get('index', { type: 'json' })) || []; } catch { index = []; }
  console.log(`${TAG} Index loaded. Total deals: ${index.length}`);

  if (index.length === 0) {
    console.log(`${TAG} No deals in index. Exiting.`);
    return new Response(JSON.stringify({ success: true, message: 'No deals in index' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 2 & 3: Find first deal that is unposted and not locked ──────────
  let targetDeal = null;
  let targetId   = null;

  for (const id of index) {
    let deal = null;
    try { deal = await store.get(id, { type: 'json' }); } catch { continue; }
    if (!deal) continue;
    if (deal.status !== 'approved') continue;

    // Step 2: Skip if already posted
    if (deal.facebookPosted === true) continue;

    // Step 3: Skip if processing lock is active (and not stale)
    if (deal.facebookProcessing === true) {
      const startedAt  = new Date(deal.facebookProcessingStarted || 0).getTime();
      const ageMs      = Date.now() - startedAt;
      if (ageMs < LOCK_STALE_MS) {
        console.log(`${TAG} Deal ${id} skipped — facebookProcessing=true (locked ${Math.round(ageMs / 1000)}s ago)`);
        continue;
      }
      // Lock is stale (>30 min) — previous run crashed. Clear it and claim the deal.
      console.warn(`${TAG} Deal ${id} — stale lock detected (${Math.round(ageMs / 60000)} min old). Clearing and retrying.`);
    }

    if (!deal.url) continue;
    targetDeal = deal;
    targetId   = id;
    break;
  }

  if (!targetDeal) {
    console.log(`${TAG} No unposted deals available. Exiting.`);
    return new Response(JSON.stringify({ success: true, message: 'No unposted deals found' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`${TAG} Selected deal:`);
  console.log(`${TAG}   Deal ID:           ${targetId}`);
  console.log(`${TAG}   facebookPosted:    ${targetDeal.facebookPosted ?? false}`);
  console.log(`${TAG}   facebookProcessing:${targetDeal.facebookProcessing ?? false}`);
  console.log(`${TAG} Full deal object from DB:`);
  console.log(JSON.stringify({
    title: targetDeal.title,
    price: targetDeal.price,
    originalPrice: targetDeal.originalPrice,
    discount: targetDeal.discount,
    discountCode: targetDeal.discountCode,
    url: targetDeal.url,
    imageUrl: targetDeal.imageUrl,
    expiresOn: targetDeal.expiresOn,
  }, null, 2));

  // ── Step 4 & 5: Set processing lock immediately ──────────────────────────
  console.log(`${TAG} Setting processing lock...`);
  await store.setJSON(targetId, {
    ...targetDeal,
    facebookProcessing: true,
    facebookProcessingStarted: new Date().toISOString(),
  });

  // ── Secondary dedup: check live Facebook posts ───────────────────────────
  console.log(`${TAG} Checking live Facebook page for existing post...`);
  const alreadyOnFacebook = await isAlreadyPostedOnFacebook(targetDeal, pageId, token);
  if (alreadyOnFacebook) {
    console.log(`${TAG} Deal ${targetId} already on Facebook — syncing DB flag.`);
    await store.setJSON(targetId, {
      ...targetDeal,
      facebookPosted: true,
      facebookProcessing: false,
      facebookPostedAt: new Date().toISOString(),
      facebookReconciled: true,
    });
    return new Response(JSON.stringify({ success: true, reconciled: true, dealId: targetId }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Validate required fields ─────────────────────────────────────────────
  const errors = validateDeal(targetDeal);
  if (errors.length > 0) {
    console.error(`${TAG} Validation failed for deal ${targetId}: ${errors.join(', ')} — skipping permanently.`);
    await store.setJSON(targetId, {
      ...targetDeal,
      facebookPosted: true,
      facebookProcessing: false,
      facebookSkipped: true,
      facebookSkipReason: errors.join(', '),
      facebookPostedAt: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ success: false, skipped: true, reason: errors.join(', ') }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 6: Post to Facebook ─────────────────────────────────────────────
  const previewCaption = buildCaption(targetDeal);
  console.log(`${TAG} ================ FACEBOOK POST ================`);
  console.log(previewCaption);
  console.log(`${TAG} ===============================================`);
  console.log(`${TAG} Posting to Facebook...`);
  let fbResult;
  try {
    fbResult = await postToFacebook(targetDeal, pageId, token);
  } catch (err) {
    // ── Step 8: Failure — release lock, log error ────────────────────────
    console.error(`${TAG} Facebook post FAILED for deal ${targetId}: ${err.message}`);
    await store.setJSON(targetId, {
      ...targetDeal,
      facebookProcessing: false,
      facebookLastError: err.message,
      facebookLastAttempt: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Step 7: Success — mark posted and release lock ───────────────────────
  console.log(`${TAG} Facebook success. Post ID: ${fbResult.id || 'n/a'}`);
  console.log(`${TAG} Updating facebookPosted=true for deal ${targetId}...`);
  await store.setJSON(targetId, {
    ...targetDeal,
    facebookPosted: true,
    facebookProcessing: false,
    facebookPostedAt: new Date().toISOString(),
    facebookPostId: fbResult.id || null,
  });
  console.log(`${TAG} Done. Deal "${targetDeal.title}" successfully posted and marked.`);

  return new Response(
    JSON.stringify({ success: true, dealId: targetId, title: targetDeal.title, facebookPostId: fbResult.id || null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
export const config = {
  schedule: "0 */3 * * *"
};
