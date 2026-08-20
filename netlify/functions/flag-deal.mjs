import { getStore } from "@netlify/blobs";

async function checkCodeOnAmazon(productUrl, code) {
  try {
    const asinMatch = productUrl.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinMatch) return false;
    const url = `https://www.amazon.com/dp/${asinMatch[1]}`;
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

function flagReasonFor(issueType) {
  if (issueType === 'missing-price') return 'missing-price';
  if (issueType === 'missing-image') return 'missing-image';
  if (issueType === 'missing-price-image') return 'missing-price-and-image';
  return 'expired-code-not-found-on-amazon';
}

async function saveFlag({ dealId, dealSource, code, productUrl, issueType }) {
  const flagReason = flagReasonFor(issueType);
  if (dealSource === 'submission') {
    const store = getStore("submissions");
    let record;
    try { record = await store.get(dealId, { type: "json" }); } catch {
      return false;
    }
    if (!record) return false;
    record.status = 'needs-review';
    record.flaggedAt = new Date().toISOString();
    record.flagReason = flagReason;
    await store.setJSON(dealId, record);
    return true;
  }

  const flagStore = getStore("flagged-deals");
  await flagStore.setJSON(`flag-${dealId}`, {
    dealId,
    code: code || null,
    productUrl,
    issueType,
    flaggedAt: new Date().toISOString(),
    flagReason,
    status: 'needs-review',
  });
  return true;
}

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const { dealId, dealSource, code, productUrl, issueType = 'expired-code' } = await req.json();
    if (!dealId || !productUrl) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
    }
    if (issueType === 'expired-code' && !code) {
      return new Response(JSON.stringify({ error: 'Missing promo code' }), { status: 400 });
    }

    if (issueType === 'expired-code') {
      const codeFound = await checkCodeOnAmazon(productUrl, code);
      if (codeFound) {
        return new Response(JSON.stringify({ ok: true, action: 'ignored', reason: 'code_still_valid' }), { status: 200 });
      }
    }

    const saved = await saveFlag({ dealId, dealSource, code, productUrl, issueType });
    if (!saved) {
      return new Response(JSON.stringify({ error: 'Deal not found' }), { status: 404 });
    }

    return new Response(JSON.stringify({ ok: true, action: 'flagged', reason: flagReasonFor(issueType) }), { status: 200 });
  } catch (err) {
    console.error('flag-deal error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: "/api/flag-deal" };
