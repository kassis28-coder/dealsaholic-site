// email-extraction-engine.mjs
// Extraction engine. Sends each product section to Claude for structured field extraction.
// NO database writes. NO affiliate links. NO regex heuristics. NO guessing.
// Returns a report only.

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_PRODUCTS = 10;

function htmlToText(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findAmazonUrls(text) {
  const pattern = /https?:\/\/(?:www\.)?(?:amazon\.com|amzn\.to|amzn\.com|a\.co)\/[^\s"'<>)]+/gi;
  const seen = new Set(), urls = [];
  for (const url of (text.match(pattern) || [])) {
    const clean = url.replace(/[)>\s'"]+$/, '');
    if (!seen.has(clean)) { seen.add(clean); urls.push(clean); }
  }
  return urls;
}

function splitIntoProductSections(text, urls) {
  if (urls.length === 0) return [];
  const positions = [];
  for (const url of urls) {
    const idx = text.indexOf(url);
    if (idx >= 0) positions.push({ url, idx, end: idx + url.length });
  }
  positions.sort((a, b) => a.idx - b.idx);
  return positions.map((p, i) => {
    const start = i === 0 ? 0 : positions[i - 1].end;
    const end   = i === positions.length - 1 ? text.length : positions[i + 1].idx;
    return { url: p.url, section: text.slice(start, end).trim() };
  });
}

async function extractProductWithClaude(section, url, apiKey) {
  const prompt = `You are a data extraction assistant. Read the text below and extract product information.

STRICT RULES:
- Extract only what is explicitly written in the text. Do not guess or infer.
- If a field is not clearly present in the text, return null for that field.
- Never copy data from one field to fill another.
- Never calculate or derive values.
- Return a single JSON object with exactly these fields:

{
  "productName": string or null,
  "dealPrice": string or null,
  "originalPrice": string or null,
  "promoCode": string or null,
  "expirationDate": string or null,
  "asin": string or null,
  "amazonUrl": string or null,
  "imageUrl": string or null
}

Field definitions:
- productName: The full product title as written.
- dealPrice: The sale/deal/current price as written (include $ if present).
- originalPrice: The original/regular/was price as written (include $ if present).
- promoCode: A coupon, promo, or discount code (letters and numbers only, as written).
- expirationDate: When the deal expires, as written.
- asin: Amazon product ID (10-character alphanumeric). Extract from URL or text.
- amazonUrl: Use this URL: ${url}
- imageUrl: A direct URL to a product image (jpg, jpeg, png, webp, gif).

Return ONLY the JSON object. No explanation. No markdown. No commentary.

TEXT:
---
${section.slice(0, 3000)}
---`;

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error('Claude API ' + res.status + ': ' + body.slice(0, 200));
  }

  const data = await res.json();
  const raw  = data.content?.[0]?.text?.trim() || '';
  const tokens = data.usage || {};

  try {
    const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    return { ok: true, fields: JSON.parse(jsonText), raw, tokens };
  } catch (e) {
    return { ok: false, fields: null, raw, error: 'JSON parse failed: ' + e.message, tokens };
  }
}

export default async (req) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Netlify environment' }), { status: 500, headers: { 'Content-Type': 'application/json' } });

    let rawHtml = '', plainText = '';
    const ct = req.headers.get('content-type') || '';

    if (ct.includes('application/json')) {
      const b = await req.json();
      rawHtml = b.htmlBody || b.html || ''; plainText = b.textBody || b.text || '';
    } else if (ct.includes('multipart/form-data') || ct.includes('application/x-www-form-urlencoded')) {
      const f = await req.formData();
      rawHtml = f.get('htmlBody') || f.get('html') || ''; plainText = f.get('textBody') || f.get('text') || '';
    } else {
      rawHtml = await req.text();
    }

    if (!rawHtml && !plainText) return new Response(JSON.stringify({ error: 'No email content received. Send htmlBody or textBody.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const emailText = htmlToText(rawHtml) || plainText;
    const allUrls   = findAmazonUrls(rawHtml + '\n' + plainText);
    const sections  = splitIntoProductSections(emailText, allUrls.slice(0, MAX_PRODUCTS));

    const products = [];
    let totalIn = 0, totalOut = 0;

    for (const { url, section } of sections) {
      const result = await extractProductWithClaude(section, url, apiKey);
      totalIn  += result.tokens?.input_tokens  || 0;
      totalOut += result.tokens?.output_tokens || 0;
      products.push({
        amazonUrl:       url,
        sectionPreview:  section.slice(0, 400),
        extraction:      result.ok ? result.fields : null,
        extractionOk:    result.ok,
        extractionError: result.ok ? null : result.error,
        rawResponse:     result.raw,
      });
    }

    return new Response(JSON.stringify({
      summary: {
        emailHtmlLength: rawHtml.length,
        emailTextLength: emailText.length,
        amazonUrlsFound: allUrls.length,
        productsExtracted: products.length,
        model: MODEL,
        tokensUsed: { input: totalIn, output: totalOut },
      },
      allUrlsFound: allUrls,
      products,
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

export const config = { path: '/api/email-extraction-engine' };
