import { getStore } from "@netlify/blobs";

// Converts an Amazon URL to a JoyLink deeplink.
// Caches results in the "joylink-cache" blob store keyed by tracking ID + ASIN
// so each product only burns one API call (limit: 1440/day).
export default async (req) => {
  let body = {};
  try { body = await req.json(); } catch {}
  const { url, asin } = body;

  if (!url) {
    return new Response(JSON.stringify({ error: 'url required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.JOYLINK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'JOYLINK_API_KEY not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  const cache = getStore('joylink-cache');
  const trackingId = process.env.AMAZON_PARTNER_TAG || 'daholic-20';
  const cacheKey = `${trackingId}:${asin || url}`;

  // Return cached link if available
  try {
    const cached = await cache.get(cacheKey, { type: 'json' });
    if (cached?.url) {
      return new Response(JSON.stringify({ url: cached.url, cached: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  } catch {}

  // Create new JoyLink
  try {
    const res = await fetch('https://api.joylink.io/public/createlink', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        destination: url,
        trackingid: trackingId,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.url) {
      console.error('JoyLink API error:', JSON.stringify(data));
      return new Response(JSON.stringify({ error: data.error || 'JoyLink API failed' }), {
        status: 502, headers: { 'Content-Type': 'application/json' },
      });
    }

    // Cache forever — JoyLink links don't expire
    await cache.setJSON(cacheKey, { url: data.url, createdAt: new Date().toISOString() });

    return new Response(JSON.stringify({ url: data.url }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    console.error('create-joylink error:', e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
};
