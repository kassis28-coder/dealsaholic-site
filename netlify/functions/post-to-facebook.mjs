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

// ── Validation — skip instead of posting incomplete content ──────────────────

function validateDeal(deal) {
  const errors = [];
  if (!deal.title)    errors.push('missing title');
  if (!deal.price)    errors.push('missing price');
  if (!deal.url)      errors.push('missing url');
  if (!deal.imageUrl) errors.push('missing imageUrl');
  return errors;
}

// ── Facebook Graph API call ──────────────────────────────────────────────────

async function postToFacebook(deal) {
  const pageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  const token  = process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;

  if (!pageId || !token) throw new Error('Missing FB_PAGE_ID or FB_PAGE_TOKEN env vars');

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
  const submissionsStore = getStore('submissions');

  let index = [];
  try { index = (await submissionsStore.get('index', { type: 'json' })) || []; } catch { index = []; }

  if (index.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'No deals in index' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Find first approved deal not yet posted to Facebook
  let targetDeal = null;
  let targetId   = null;

  for (const id of index) {
    let deal = null;
    try { deal = await submissionsStore.get(id, { type: 'json' }); } catch { continue; }
    if (!deal) continue;
    if (deal.status !== 'approved') continue;
    if (deal.facebookPosted === true) continue;
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
    console.error(`[post-to-facebook] Skipping deal ${targetId}: ${errors.join(', ')}`);
    await submissionsStore.setJSON(targetId, {
      ...targetDeal,
      facebookPosted: true,
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
    fbResult = await postToFacebook(targetDeal);
  } catch (err) {
    console.error('[post-to-facebook] FB API error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Mark posted
  await submissionsStore.setJSON(targetId, {
    ...targetDeal,
    facebookPosted: true,
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
