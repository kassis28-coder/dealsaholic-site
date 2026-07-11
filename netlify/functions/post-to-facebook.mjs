import { getStore } from "@netlify/blobs";

// ── Caption builder ──────────────────────────────────────────────────────────

function buildCaption(deal) {
  const parts = [];

  if (deal.title) parts.push(`🛍️ ${deal.title}`);
  if (deal.price) {
    const priceStr = deal.originalPrice
      ? `💰 ${deal.price} (was ${deal.originalPrice})`
      : `💰 ${deal.price}`;
    if (deal.discount) parts.push(`${priceStr} — ${deal.discount}% OFF`);
    else parts.push(priceStr);
  }
  if (deal.promoCode) parts.push(`🎟️ Promo code: ${deal.promoCode}`);
  if (deal.url) parts.push(`🔗 ${deal.url}`);
  parts.push('\n#deals #amazon #dealsaholic #shopping #sale');

  return parts.join('\n\n');
}

// ── Facebook Graph API call ──────────────────────────────────────────────────

async function postToFacebook(deal) {
  const pageId = process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;

  if (!pageId || !token) {
    throw new Error('Missing FB_PAGE_ID or FB_PAGE_TOKEN env vars');
  }

  const caption = buildCaption(deal);
  const imageUrl = deal.imageUrl || null;

  // Use /photos if we have an image, otherwise /feed
  if (imageUrl) {
    const params = new URLSearchParams({
      url: imageUrl,
      caption,
      access_token: token,
      published: 'true',
    });
    const res = await fetch(`https://graph.facebook.com/${pageId}/photos`, {
      method: 'POST',
      body: params,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`FB API error: ${JSON.stringify(data)}`);
    return { id: data.id, post_id: data.post_id };
  } else {
    const params = new URLSearchParams({
      message: caption,
      access_token: token,
    });
    const res = await fetch(`https://graph.facebook.com/${pageId}/feed`, {
      method: 'POST',
      body: params,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`FB API error: ${JSON.stringify(data)}`);
    return { id: data.id };
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

  // 2. Find the first approved, unposted-to-Facebook deal
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
    if (deal.facebookPosted === true) continue;
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

  // 3. Post to Facebook
  let fbResult;
  try {
    fbResult = await postToFacebook(targetDeal);
  } catch (err) {
    console.error('[post-to-facebook] FB API error:', err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 4. Mark the deal as posted — save back to submissions store
  const updatedDeal = {
    ...targetDeal,
    facebookPosted: true,
    facebookPostedAt: new Date().toISOString(),
    facebookPostId: fbResult.id || null,
  };
  await submissionsStore.setJSON(targetId, updatedDeal);

  console.log(`[post-to-facebook] Posted deal ${targetId}: ${targetDeal.title}`);

  return new Response(
    JSON.stringify({
      success: true,
      dealId: targetId,
      title: targetDeal.title,
      facebookPostId: fbResult.id || null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};

export const config = { schedule: '*/15 * * * *' };
