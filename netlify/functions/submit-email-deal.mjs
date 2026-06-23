import { getStore } from "@netlify/blobs";

async function followRedirectForAsin(amazonUrl) {
  try {
    const res = await fetch(amazonUrl, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    });
    const finalUrl = res.url || amazonUrl;
    const asin = finalUrl.match(/\/dp\/([A-Z0-9]{10})/i)?.[1] || null;
    return { asin, finalUrl };
  } catch (e) {
    return { asin: null, finalUrl: amazonUrl };
  }
}

function extractPromoCodeFromText(text) {
  if (!text) return null;
  const patterns = [
    /(?:use|apply|enter|add|with)\s+(?:promo(?:tional)?\s+)?code[:\s]+([A-Z0-9]{4,20})/i,
    /(?:promo(?:tional)?|coupon|discount)\s+code[:\s]+([A-Z0-9]{4,20})/i,
    /\bcode[:\s]+([A-Z0-9]{6,20})\b/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseDealBlocks(text) {
  const deals = [];
  const blocks = text.split(/(?=\b\d{1,2}[.\u3001\uff0c]\s)/);

  for (const block of blocks) {
    if (block.trim().length < 20) continue;

    const urlMatch = block.match(/https?:\/\/(?:www\.)?amazon\.com\/(?:dp|gp\/product)\/[A-Z0-9]{10}[^\s"'\u201c\u201d<>]*/i)
      || block.match(/https?:\/\/amzn\.to\/[A-Za-z0-9]+/i)
      || block.match(/https?:\/\/a\.co\/[A-Za-z0-9\/]+/i);
    if (!urlMatch) continue;

    const url = urlMatch[0].replace(/["\u201d]+$/, '');

    const titleMatch = block.match(/product\s+name[:\s]+([^\n]{10,150})/i)
      || block.match(/^\d+[.\u3001]\s*"?([^\n"]{10,150})/i);
    const title = titleMatch ? titleMatch[1].replace(/"/g, '').trim().substring(0, 150) : null;

    const dealPriceMatch = block.match(/deal\s+price\s*[:$]?\s*\$?([\d.,]+)/i)
      || block.match(/price\s*[:$]?\s*\$?([\d.,]+)/i)
      || block.match(/\$\s*([\d.,]+)/i);
    const price = dealPriceMatch ? '$' + dealPriceMatch[1].split('-')[0].trim() : null;

    const origPriceMatch = block.match(/original\s+price\s*[:$]?\s*\$?([\d.,]+)/i);
    const originalPrice = origPriceMatch ? '$' + origPriceMatch[1].split('-')[0].trim() : null;

    const discountMatch = block.match(/(\d+)\s*%\s*(?:off|BD|discount)/i);
    const discount = discountMatch ? discountMatch[1] : null;

    const code = extractPromoCodeFromText(block);

    deals.push({ url, title, price, originalPrice, discount, code });
  }

  return deals;
}

async function getAsinImageAndTitle(url) {
  const { asin } = await followRedirectForAsin(url);
  const imageUrl = asin ? 'https://m.media-amazon.com/images/P/' + asin + '.01._SCLZZZZZZZ_.jpg' : null;
  const affiliateUrl = asin
    ? 'https://www.amazon.com/dp/' + asin + '?tag=kethya08-20'
    : url.includes('tag=') ? url : url + (url.includes('?') ? '&' : '?') + 'tag=kethya08-20';
  return { asin, imageUrl, affiliateUrl };
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
  const dealBlocks = parseDealBlocks(plainText);
  const blocksToProcess = dealBlocks.slice(0, 15);

  const store = getStore("submissions");
  const savedIds = [];
  const deals = [];

  for (const block of blocksToProcess) {
    const { asin, imageUrl, affiliateUrl } = await getAsinImageAndTitle(block.url);

    const id = 'email-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const submission = {
      id,
      title: block.title || 'Amazon Deal',
      price: block.price || null,
      originalPrice: block.originalPrice || null,
      discount: block.discount || null,
      url: affiliateUrl,
      imageUrl,
      discountCode: block.code || null,
      source: 'email',
      status: affiliateUrl ? 'approved' : 'pending',
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    await store.setJSON(id, submission);
    savedIds.push(id);

    const dealObj = {
      id,
      title: block.title || 'Amazon Deal',
      price: block.price || null,
      url: affiliateUrl,
      imageUrl,
      promoCode: block.code || null,
    };
    deals.push(dealObj);

    let index = [];
    try { index = await store.get('index', { type: 'json' }) || []; } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON('index', index);

    await postToTelegram(dealObj);
    await new Promise(r => setTimeout(r, 1000));
  }

  return new Response(JSON.stringify({
    success: true,
    count: deals.length,
    ids: savedIds,
    deals,
    blocksFound: dealBlocks.length,
    title: deals[0]?.title || null,
    price: deals[0]?.price || null,
    url: deals[0]?.url || null,
    imageUrl: deals[0]?.imageUrl || null,
    promoCode: deals[0]?.promoCode || null,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/submit-email-deal' };
