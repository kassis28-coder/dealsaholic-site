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

function extractAllAmazonUrls(text) {
  const seen = new Set();
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
      if (!seen.has(key)) {
        seen.add(key);
        urls.push({ url, asin });
      }
    }
  }
  return urls;
}

function getContextAroundUrl(text, url, windowSize = 300) {
  const idx = text.indexOf(url);
  if (idx === -1) return '';
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + url.length + windowSize);
  return text.slice(start, end);
}

function extractPrice(context) {
  const patterns = [
    /deal\s+price\s*[:$]?\s*\$?([\d.]+)/i,
    /\n([\d.]+)(?:-[\d.]+)?\s*\(Reg/i,
    /price\s*[:$]?\s*\$?([\d.]+)/i,
    /\$([\d.]+)/,
    /\b([\d.]+)\s*\(Reg/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m && parseFloat(m[1]) > 0) return '$' + m[1];
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
  const m = context.match(/(\d+)\s*%\s*off/i);
  return m ? m[1] : null;
}

function extractPromoCode(context) {
  const patterns = [
    /(?:use|apply|enter|add|with)\s+(?:promo(?:tional)?\s+)?code[:\s]+([A-Z0-9]{4,20})/i,
    /(?:promo(?:tional)?|coupon|discount)\s+code[:\s]+([A-Z0-9]{4,20})/i,
    /\bcode[:\s]+([A-Z0-9]{6,20})\b/i,
  ];
  for (const pat of patterns) {
    const m = context.match(pat);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function extractTitleFromContext(context) {
  const patterns = [
    /product\s+name[:\s]+"?([^\n"]{10,150})/i,
    /\d+%\s+off\s+([A-Z][^\n]{10,120})/,
    /#\d+\s*\n([^\n]{10,150})/,
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
    return { title: cleanTitle(title), price };
  } catch (e) {
    return null;
  }
}

async function postToTelegram(deal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
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
      if (!data.ok) {
        await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: safeCaption }),
        });
      }
    } else {
      const text = caption.length > 4096 ? caption.substring(0, 4093) + '...' : caption;
      await fetch('https://api.telegram.org/bot' + botToken + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
    }
  } catch (e) {
    console.error('Telegram post failed:', e.message);
  }
}

export default async (req, context) => {
  let emailBody = '';

  if (req.method === 'GET') {
    const urlObj = new URL(req.url);
    emailBody = urlObj.searchParams.get('emailBody') || '';
  } else if (req.method === 'POST') {
    try {
      const text = await req.text();
      try {
        const parsed = JSON.parse(text);
        emailBody = parsed.emailBody || parsed.body || text;
      } catch (e) {
        emailBody = text;
      }
    } catch (e) { emailBody = ''; }
  }

  const plainText = stripHtml(emailBody || '');
  const amazonUrls = extractAllAmazonUrls(plainText);
  const productUrls = amazonUrls.filter(({ url }) => !url.includes('/promocode/'));
  const toProcess = productUrls.slice(0, 15);

  const store = getStore("submissions");
  const savedIds = [];
  const deals = [];

  for (const { url, asin } of toProcess) {
    const context = getContextAroundUrl(plainText, url);
    const imageUrl = asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg' : null;
    const affiliateUrl = asin
      ? 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20'
      : url + (url.includes('?') ? '&' : '?') + 'tag=kethya08-20';

    let title = extractTitleFromContext(context);
    let price = extractPrice(context);
    const originalPrice = extractOriginalPrice(context);
    const discount = extractDiscount(context);
    const promoCode = extractPromoCode(context);

    if ((!title || !price) && asin) {
      const scraped = await scrapeAmazon(asin);
      if (scraped) {
        title = title || scraped.title;
        price = price || scraped.price;
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
    urlsFound: productUrls.length,
    title: deals[0]?.title || null, price: deals[0]?.price || null,
    url: deals[0]?.url || null, imageUrl: deals[0]?.imageUrl || null,
    promoCode: deals[0]?.promoCode || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/submit-email-deal' };
