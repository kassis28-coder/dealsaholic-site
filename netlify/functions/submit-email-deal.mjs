import { getStore } from "@netlify/blobs";

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function cleanTitle(title) {
  if (!title) return null;
  return title
    .replace(/^amazon\.com\s*[:]\s*/i, '')
    .replace(/\s*[|:]\s*amazon\.com.*/i, '')
    .replace(/\s*-\s*amazon\.com.*/i, '')
    .replace(/^["'\u201c]|["'\u201d]$/g, '')
    .trim()
    .substring(0, 150);
}

function extractUrlsFromHtml(html) {
  const seen = new Set();
  const urls = [];
  const hrefPattern = /href=["']([^"']*amazon\.com[^"']*)/gi;
  let m;
  while ((m = hrefPattern.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&');
    const asin = url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]
      || url.match(/\/gp\/product\/([A-Z0-9]{10})/i)?.[1];
    if (!asin) continue;
    if (seen.has(asin)) continue;
    seen.add(asin);
    urls.push({ url: 'https://www.amazon.com/dp/' + asin, asin });
  }
  return { urls, seen };
}

function extractUrlsFromText(text, seen) {
  const urls = [];
  const patterns = [
    /https?:\/\/(?:www\.)?amazon\.com\/dp\/([A-Z0-9]{10})[^\s"'<>\u201d]*/gi,
    /https?:\/\/(?:www\.)?amazon\.com\/gp\/product\/([A-Z0-9]{10})[^\s"'<>\u201d]*/gi,
    /https?:\/\/amzn\.to\/[A-Za-z0-9]+/gi,
    /https?:\/\/a\.co\/[A-Za-z0-9\/]+/gi,
  ];
  for (const pattern of patterns) {
    const matches = [...text.matchAll(pattern)];
    for (const m of matches) {
      const url = m[0].replace(/["\u201d\u201c']+$/, '');
      const asin = url.match(/\/dp\/([A-Z0-9]{10})/i)?.[1]
        || url.match(/\/product\/([A-Z0-9]{10})/i)?.[1];
      const key = asin || url;
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push({ url: asin ? 'https://www.amazon.com/dp/' + asin : url, asin: asin || null });
    }
  }
  return urls;
}

function getContextAroundUrl(text, url, asin, windowSize = 400) {
  let idx = asin ? text.indexOf(asin) : -1;
  if (idx === -1) idx = text.indexOf(url);
  if (idx === -1) return text.substring(0, 800);
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + (asin || url).length + windowSize);
  return text.slice(start, end);
}

function extractPrice(context) {
  const patterns = [
    /deal\s+price\s*[:$]?\s*\$?([\d.]+)/i,
    /discount\s+price\s*[:$]?\s*\$?([\d.]+)/i,
    /\n([\d.]+)(?:-[\d.]+)?\s*\(Reg/i,
    /price\s*[:$]?\s*\$?([\d.]+)/i,
    /\$([\d.]+)/,
    /\b([\d.]+)\s*\(Reg/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m && parseFloat(m[1]) > 0 && parseFloat(m[1]) < 10000) return '$' + m[1];
  }
  return null;
}

function extractOriginalPrice(context) {
  const patterns = [
    /\(Reg\.?\s*\$?([\d.]+)/i,
    /original\s+price\s*[:$]?\s*\$?([\d.]+)/i,
    /was\s*[:$]?\s*\$?([\d.]+)/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return '$' + m[1];
  }
  return null;
}

function extractDiscount(context) {
  const m = context.match(/(\d+)\s*%\s*(?:off|code|discount)/i);
  return m ? m[1] : null;
}

function extractPromoCode(context) {
  const patterns = [
    /(?:use|apply|enter|add|with)\s+(?:promo(?:tional)?\s+)?code[:\s]+([A-Z0-9]{4,20})/i,
    /(?:promo(?:tional)?|coupon|discount)\s+code[:\s]+([A-Z0-9]{4,20})/i,
    /\bcode[:\u3001:\s]+([A-Z0-9]{6,20})\b/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function extractTitleFromContext(context) {
  const patterns = [
    /product\s+name[:\u3001\s]+"?([^\n"]{10,200})/i,
    /\d+%\s+off\s+([A-Z][^\n]{10,150})/,
    /#\d+\s+([A-Z][^\n]{10,150})/,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return cleanTitle(m[1].trim());
  }
  return null;
}

async function scrapeAmazon(asin) {
  try {
    const res = await fetch('https://www.amazon.com/dp/' + asin, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || null;
    const priceMatch = html.match(/"priceAmount":([\d.]+)/)
      || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;
   const image = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || null;
return { title: cleanTitle(title), price, image };
  } catch (e) {
    return null;
  }
}

async function postToTelegram(deal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log('Telegram botToken exists:', !!botToken);
  console.log('Telegram chatId:', chatId);
  if (!botToken || !chatId) return;

  const codeLine = deal.promoCode ? '\n\u{1F3F7} Code: ' + deal.promoCode : '';
  const caption = '\u{1F525} New Deal Alert!\n\n\u{1F6CD} ' + (deal.title || 'Amazon Deal') + '\n\n\u{1F4B0} ' + (deal.price || 'Check link') + codeLine + '\n\n\u{1F449} ' + deal.url;
  const safeCaption = caption.length > 1024 ? caption.substring(0, 1021) + '...' : caption;

  try {
    if (deal.imageUrl) {
      const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendPhoto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo: deal.imageUrl, caption: safeCaption }),
      });
      const data = await res.json();
      console.log('Telegram sendPhoto response:', JSON.stringify(data));
      if (!data.ok) {
        const res2 = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: safeCaption }),
        });
        const data2 = await res2.json();
        console.log('Telegram sendMessage response:', JSON.stringify(data2));
      }
    } else {
      const text = caption.length > 4096 ? caption.substring(0, 4093) + '...' : caption;
      const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const data = await res.json();
      console.log('Telegram sendMessage response:', JSON.stringify(data));
    }
  } catch (e) {
    console.error('Telegram post failed:', e.message);
  }
}

export default async (req, context) => {
  let emailBody = '';
  let emailText = '';

  if (req.method === 'GET') {
    const urlObj = new URL(req.url);
    emailBody = urlObj.searchParams.get('emailBody') || '';
    emailText = urlObj.searchParams.get('emailText') || '';
  } else if (req.method === 'POST') {
    try {
      const raw = await req.text();
      const contentType = req.headers.get('content-type') || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(raw);
        emailBody = params.get('emailBody') || '';
        emailText = params.get('emailText') || '';
      } else {
        try {
          const parsed = JSON.parse(raw);
          emailBody = parsed.emailBody || parsed.body || '';
          emailText = parsed.emailText || '';
        } catch (e) {
          emailBody = raw;
        }
      }
    } catch (e) { emailBody = ''; }
  }

  const { urls: htmlUrls, seen } = extractUrlsFromHtml(emailBody);
  const plainText = stripHtml(emailBody) + ' ' + emailText;
  const textUrls = extractUrlsFromText(plainText, seen);
  const allUrls = [...htmlUrls, ...textUrls].filter(({ url }) => !url.includes('/promocode/'));
  const toProcess = allUrls.slice(0, 15);

  const store = getStore("submissions");
  const savedIds = [];
  const deals = [];

  for (const { url, asin } of toProcess) {
    const context = getContextAroundUrl(plainText, url, asin);
    let imageUrl = asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg' : null;
    const affiliateUrl = asin
      ? 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20'
      : url + (url.includes('?') ? '&' : '?') + 'tag=kethya08-20';

    let title = extractTitleFromContext(context);
    let price = extractPrice(context);
    const originalPrice = extractOriginalPrice(context);
    const discount = extractDiscount(context);
    const promoCode = extractPromoCode(context);

  if (asin) {
  const scraped = await scrapeAmazon(asin);
  if (scraped) {
    title = scraped.title || title;
    price = price || scraped.price;
    if (scraped.image) imageUrl = scraped.image;
  }
}
    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id, title: title || 'Amazon Deal', price: price || null,
      originalPrice: originalPrice || null, discount: discount || null,
      url: affiliateUrl, imageUrl, discountCode: promoCode || null,
      source: 'email', status: 'approved', sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.setJSON(id, submission);
    savedIds.push(id);

    const dealObj = { id, title: title || 'Amazon Deal', price, url: affiliateUrl, imageUrl, promoCode };
    deals.push(dealObj);

    let index = [];
    try { index = await store.get('index', { type: 'json' }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON('index', index);

    await postToTelegram(dealObj);
    await new Promise(r => setTimeout(r, 1000));
  }

  return new Response(JSON.stringify({
    success: true, count: deals.length, ids: savedIds, deals,
    urlsFound: allUrls.length,
    title: deals[0]?.title || null, price: deals[0]?.price || null,
    url: deals[0]?.url || null, imageUrl: deals[0]?.imageUrl || null,
    promoCode: deals[0]?.promoCode || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/submit-email-deal' };
