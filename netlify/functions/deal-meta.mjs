// netlify/functions/deal-meta.mjs
// Serves /deal with server-side OG meta tags so link previews show the deal image.

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default async (req) => {
  const url = new URL(req.url);
  const p = url.searchParams;

  const asin       = p.get('asin') || '';
  const rawTitle   = p.get('title') || '';
  const rawPrice   = p.get('price') || '';
  const rawOrig    = p.get('original') || '';
  const discount   = p.get('discount') || '';
  const rawImage   = p.get('image') || '';
  const rawCode    = p.get('code') || '';
  const store      = p.get('store') || 'amazon';
  const rawUrl     = p.get('url') || '';

  // URLSearchParams already decodes query values. Decoding a second time can
  // throw for legitimate titles containing a percent sign.
  const title      = rawTitle;
  const price      = rawPrice;
  const orig       = rawOrig;
  const image      = rawImage || 'https://deals-aholic.com/og-image.jpg';
  const code       = rawCode;
  const productUrl = rawUrl;

  const pageTitle = title ? `${title} — Deals-aholic` : 'Deal — Deals-aholic';
  const descParts = [];
  if (price)    descParts.push(price);
  if (discount) descParts.push(`${discount}% off`);
  if (orig)     descParts.push(`was ${orig}`);
  descParts.push('Shop now on Deals-aholic!');
  const description = descParts.join(' · ');

  const canonicalUrl = `https://deals-aholic.com/deal?${p.toString()}`;

  let affiliateUrl = '';
  if (asin) {
    affiliateUrl = `https://www.amazon.com/dp/${asin}?tag=daholic-20&linkCode=ll1&language=en_US`;
  } else if (productUrl) {
    affiliateUrl = productUrl;
  }

  const storeLabel =
    store === 'walmart' ? '🛒 Go to Walmart' :
    store === 'temu'    ? '🛒 Go to Temu' :
    store === 'other'   ? '🛍️ View Deal' :
                          '🛍️ Go to Amazon';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonicalUrl)}">
<meta property="og:type" content="product">
<meta property="og:url" content="${esc(canonicalUrl)}">
<meta property="og:title" content="${esc(title || 'Deal — Deals-aholic')}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="800">
<meta property="og:image:height" content="800">
<meta property="og:site_name" content="Deals-aholic">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title || 'Deal — Deals-aholic')}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root { --paper: #FAF8F4; --card: #FFFFFF; --ink: #1C1A17; --ink-soft: #6B6459; --line: #ECE6DB; --brand: #FF8A1E; --brand-dark: #D96E0C; --green: #1C8C5A; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); font-family: 'Inter', sans-serif; color: var(--ink); min-height: 100vh; display: flex; flex-direction: column; }
  .nav { background: var(--card); border-bottom: 1px solid var(--line); padding: 14px 24px; display: flex; align-items: center; }
  .nav__logo { font-family: 'Archivo Black', sans-serif; font-size: 19px; color: var(--ink); text-transform: uppercase; letter-spacing: -0.01em; text-decoration: none; }
  .nav__logo span { color: var(--brand); }
  .container { max-width: 480px; margin: 0 auto; padding: 32px 24px; flex: 1; }
  .deal-image { width: 100%; max-width: 280px; display: block; margin: 0 auto 24px; border-radius: 12px; background: #fff; padding: 16px; border: 1px solid var(--line); object-fit: contain; }
  .deal-title { font-size: 18px; font-weight: 600; line-height: 1.4; margin: 0 0 16px; text-align: center; }
  .deal-price-row { display: flex; align-items: baseline; gap: 12px; justify-content: center; margin-bottom: 8px; }
  .deal-price { font-family: 'Archivo Black', sans-serif; font-size: 32px; color: var(--ink); }
  .deal-price-original { font-size: 18px; color: var(--ink-soft); text-decoration: line-through; }
  .deal-badge { display: inline-block; background: var(--green); color: #fff; font-weight: 700; font-size: 14px; padding: 6px 14px; border-radius: 999px; margin-bottom: 20px; }
  .deal-code { background: #FFF3E0; border: 1.5px dashed var(--brand); border-radius: 10px; padding: 14px; text-align: center; margin-bottom: 24px; }
  .deal-code__label { font-size: 13px; color: var(--ink-soft); margin-bottom: 6px; }
  .deal-code__value { font-size: 20px; font-weight: 700; letter-spacing: 2px; }
  .deal-code__copy { display: block; margin-top: 10px; font-size: 13px; color: var(--brand); cursor: pointer; background: none; border: none; font-family: 'Inter', sans-serif; font-weight: 600; }
  .cta-btn { display: block; width: 100%; background: var(--brand); color: #fff; font-weight: 700; font-size: 18px; text-align: center; border-radius: 12px; padding: 18px 0; text-decoration: none; margin-bottom: 16px; box-shadow: 0 4px 14px rgba(255,138,30,0.4); cursor: pointer; border: none; font-family: 'Inter', sans-serif; }
  .cta-btn:hover { background: var(--brand-dark); }
  .back-link { display: block; text-align: center; font-size: 14px; color: var(--ink-soft); text-decoration: none; margin-bottom: 32px; }
  .disclaimer { font-size: 11px; color: var(--ink-soft); text-align: center; line-height: 1.5; }
</style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav__logo">Deals-<span>aholic</span></a>
</nav>
<div class="container">
  ${image !== 'https://deals-aholic.com/og-image.jpg' ? `<img class="deal-image" src="${esc(image)}" alt="${esc(title)}">` : ''}
  ${title ? `<h1 class="deal-title">${esc(title)}</h1>` : ''}
  <div style="text-align:center">
    <div class="deal-price-row">
      ${price ? `<span class="deal-price">${esc(price)}</span>` : ''}
      ${orig  ? `<span class="deal-price-original">${esc(orig)}</span>` : ''}
    </div>
    ${discount ? `<div class="deal-badge">${esc(discount)}% OFF</div>` : ''}
  </div>
  ${code ? `
  <div class="deal-code">
    <div class="deal-code__label">Use this code at checkout</div>
    <div class="deal-code__value" id="deal-code-val">${esc(code)}</div>
    <button class="deal-code__copy" onclick="copyCode()">📋 Copy Code</button>
  </div>` : ''}
  <button id="deal-cta" class="cta-btn">${esc(storeLabel)}</button>
  <a href="/" class="back-link">← Back to all deals</a>
  <p class="disclaimer">As an Amazon Associate, Deals-aholic earns from qualifying purchases. Prices and availability are subject to change.</p>
</div>
<script>
  const affiliateUrl = ${JSON.stringify(affiliateUrl)};
  const store = ${JSON.stringify(store)};
  const ua = navigator.userAgent || navigator.vendor || window.opera;
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  const isAndroid = /android/i.test(ua);

  const ctaBtn = document.getElementById('deal-cta');
  ctaBtn.addEventListener('click', async function () {
    if (!affiliateUrl) return;

    if (store === 'walmart') {
      window.location.href = affiliateUrl;
      return;
    }

    const originalText = ctaBtn.textContent;
    ctaBtn.textContent = '⏳ Loading deal...';
    ctaBtn.disabled = true;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
      const response = await fetch('/api/create-joylink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: affiliateUrl, asin: ${JSON.stringify(asin || null)} }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (response.ok && result.url) {
        window.location.href = result.url;
        return;
      }
    } catch (error) {
      if (error.name !== 'AbortError') console.error('JoyLink error:', error);
    } finally {
      clearTimeout(timeoutId);
    }

    ctaBtn.textContent = originalText;
    ctaBtn.disabled = false;
    window.location.href = affiliateUrl;
  });

  function copyCode() {
    const val = document.getElementById('deal-code-val').textContent;
    navigator.clipboard.writeText(val).then(() => {
      const btn = document.querySelector('.deal-code__copy');
      btn.textContent = '✅ Copied!';
      setTimeout(() => btn.textContent = '📋 Copy Code', 2000);
    });
  }
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
