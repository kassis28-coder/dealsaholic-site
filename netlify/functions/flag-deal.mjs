import { getStore } from "@netlify/blobs";

async function checkCodeOnAmazon(productUrl, code) {
  try {
    const asinMatch = productUrl.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinMatch) return false;
    const asin = asinMatch[1];
    const url = `https://www.amazon.com/dp/${asin}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    if (!res.ok) return false;
    const html = await res.text();
    return html.toLowerCase().includes(code.toLowerCase());
  } catch (err) {
    console.error('Amazon check error:', err.message);
    return true;
  }
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  try {
    const { dealId, dealSource, code, productUrl } = await req.json();
    if (!dealId || !code || !productUrl) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
    }
    const codeFound = await checkCodeOnAmazon(productUrl, code);
    if (codeFound) {
      return new Response(JSON.stringify({ ok: true, action: 'ignored', reason: 'code_still_valid' }), { status: 200 });
    }
    if (dealSource === 'submission') {
      const store = getStore("submissions");
      let record;
      try { record = await store.get(dealId, { type: "json" }); } catch {
        return new Response(JSON.stringify({ error: 'Deal not found' }), { status: 404 });
      }
      if (!record) return new Response(JSON.stringify({ error: 'Deal not found' }), { status: 404 });
      record.status = 'needs-review';
      record.flaggedAt = new Date().toISOString();
      record.flagReason = 'expired-code-not-found-on-amazon';
      await store.setJSON(dealId, record);
    } else {
      const flagStore = getStore("flagged-deals");
      await flagStore.setJSON(`flag-${dealId}`, {
        dealId, code, productUrl,
        flaggedAt: new Date().toISOString(),
        flagReason: 'expired-code-not-found-on-amazon',
        status: 'needs-review',
      });
    }
    return new Response(JSON.stringify({ ok: true, action: 'flagged', reason: 'code_not_found' }), { status: 200 });
  } catch (err) {
    console.error('flag-deal error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: "/api/flag-deal" };
