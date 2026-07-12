import { getStore } from "@netlify/blobs";

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
  if (deal.discountCode)  lines.push(`🎟️ Promo Code: ${deal.discountCode}`);
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

// ── Soft-lock helpers ────────────────────────────────────────────────────────
// Netlify Blobs has no atomic CAS. We use a facebookProcessing flag written
// BEFORE calling Facebook to shrink the race window to near-zero.
// A stale lock (crashed run) is expired after LOCK_TTL_MS.

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isProcessingLocked(deal) {
  if (!deal.facebookProcessing) return false;
  const lockedAt = new Date(deal.facebookProcessingAt || 0).getTime();
  return Date.now() - lockedAt < LOCK_TTL_MS;
}

// ── Main scheduled handler ───────────────────────────────────────────────────

export default async (_req, _context) => {
  const submissionsStore = getStore('submissions');
  const pageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  const token  = process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;

  if (!pageId || !token) {
    return new Response(JSON.stringify({ success: false, error: 'Missing FB_PAGE_ID or FB_PAGE_TOKEN' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  let index = [];
  try { index = (await submissionsStore.get('index', { type: 'json' })) || []; } catch { index = []; }

  if (index.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'No deals in index' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Find first approved deal not yet posted and not currently being processed
  let targetDeal = null;
  let targetId   = null;

  for (const id of index) {
    let deal = null;
    try { deal = await submissionsStore.get(id, { type: 'json' }); } catch { continue; }
    if (!deal) continue;
    if (deal.status !== 'approved') continue;
    if (deal.facebookPosted === true) continue;
    if (isProcessingLocked(deal)) continue;
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

  // SOFT LOCK -- write facebookProcessing=true before touching Facebook.
  // Any concurrent invocation reading this deal will now skip it.
  await submissionsStore.setJSON(targetId, {
    ...targetDeal,
    facebookProcessing: true,
    facebookProcessingAt: new Date().toISOString(),
  });

  // Secondary dedup: check live Facebook page posts
  const alreadyOnFacebook = await isAlreadyPostedOnFacebook(targetDeal, pageId, token);
  if (alreadyOnFacebook) {
    console.log(`[post-to-facebook] Deal ${targetId} already on FB page -- syncing DB flag`);
    await submissionsStore.setJSON(targetId, {
      ...targetDeal,
      facebookPosted: true,
      facebookProcessing: false,
      facebookPostedAt: new Date().toISOString(),
      facebookReconciled: true,
    });
    return new Response(JSON.stringify({ success: true, reconciled: true, dealId: targetId, message: 'Already on Facebook, DB synced' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validate
  const errors = validateDeal(targetDeal);
  if (errors.length > 0) {
    console.error(`[post-to-facebook] Skipping deal ${targetId}: ${errors.join(', ')}`);
    await submissionsStore.setJSON(targetId, {
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

  // Post to Facebook
  let fbResult;
  try {
    fbResult = await postToFacebook(targetDeal, pageId, token);
  } catch (err) {
    // Release the lock so the next run can retry
    console.error('[post-to-facebook] FB API error:', err.message);
    await submissionsStore.setJSON(targetId, { ...targetDeal, facebookProcessing: false });
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // SUCCESS -- mark posted and release lock
  await submissionsStore.setJSON(targetId, {
    ...targetDeal,
    facebookPosted: true,
    facebookProcessing: false,
    facebookPostedAt: new Date().toISOString(),
    facebookPostId: fbResult.id || null,
  });

  console.log(`[post-to-facebook] Posted deal ${targetId}: ${targetDeal.title}`);

  return new Response(
    JSON.stringify({ success: true, dealId: targetId, title: targetDeal.title, facebookPostId: fbResult.id || null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export const config = { schedule: '*/15 * * * *' };
