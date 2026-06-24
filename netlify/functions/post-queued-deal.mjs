import { getStore } from "@netlify/blobs";

async function scrapeAmazonImage(asin) {
  try {
    const res = await fetch('https://www.amazon.com/dp/' + asin, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Cache-Control': 'no-cache',
      },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const html = await res.text();
    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || null;
    const priceMatch = html.match(/"priceAmount":([\d.]+)/) || html.match(/class=["'][^"']*a-price-whole[^"']*["'][^>]*>\s*([\d,]+)/);
    const price = priceMatch ? '$' + priceMatch[1].replace(/,/g, '') : null;
    const image = html.match(/"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/"thumb":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/data-old-hires="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/id="landingImage"[^>]+src="(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/)?.[1]
      || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["'](https:\/\/m\.media-amazon\.com\/images\/I\/[^"']+)["']/i)?.[1]
      || null;
    return { title, price, image };
  } catch (e) {
    return null;
  }
}

async function postToTelegram(deal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return false;

  const storeIcon = deal.store === 'walmart' ? '🛒' : '🛍️';
  const storeName = deal.store === 'walmart' ? 'Walmart.com' : 'Amazon.com';
  const codeLine = deal.promoCode ? '\n🏷 Code: ' + deal.promoCode : '';
  const discountLine = deal.discount ? ' (' + deal.discount + '% off)' : '';
  const caption = '🔥 New Deal Alert!\n\n' + storeIcon + ' ' + storeName + '\n\n' +
    '📦 ' + (deal.title || storeName + ' Deal') + '\n\n' +
    '💰 ' + (deal.price || 'Check link') + discountLine + codeLine + '\n\n' +
    '👉 ' + deal.url;
  const safeCaption = caption.length > 1024 ? caption.substring(0, 1021) + '...' : caption;

  try {
    if (deal.imageUrl) {
      let imageSent = false;
      try {
        const imgRes = await fetch(deal.imageUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': 'https://www.amazon.com/',
          }
        });
        if (imgRes.ok) {
          const imgBuffer = await imgRes.arrayBuffer();
          const formData = new FormData();
          formData.append('chat_id', chatId);
          formData.append('caption', safeCaption);
          formData.append('photo', new Blob([imgBuffer], { type: 'image/jpeg' }), 'deal.jpg');
          const res = await fetch('https://api.telegram.org/bot' + botToken + '/sendPhoto', {
            method: 'POST',
            body: formData,
          });
          const data = await res.json();
          if (data.ok) imageSent = true;
        }
      } catch (e) {
        console.error('Image fetch/send failed:', e.message);
      }

      if (!imageSent) {
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
    return true;
  } catch (e) {
    console.error('Telegram post failed:', e.message);
    return false;
  }
}

async function postToFacebook(deal) {
  const pageToken = process.env.FACEBOOK_PAGE_TOKEN;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  if (!pageToken || !pageId) return false;

  const storeIcon = deal.store === 'walmart' ? '🛒' : '🛍️';
  const storeName = deal.store === 'walmart' ? 'Walmart.com' : 'Amazon.com';
  const codeLine = deal.promoCode ? '\n🏷 Code: ' + deal.promoCode : '';
  const discountLine = deal.discount ? ' (' + deal.discount + '% off)' : '';
  const message = '🔥 New Deal Alert!\n\n' + storeIcon + ' ' + storeName + '\n\n' +
    '📦 ' + (deal.title || storeName + ' Deal') + '\n\n' +
    '💰 ' + (deal.price || 'Check link') + discountLine + codeLine + '\n\n' +
    '👉 ' + deal.url;

  try {
    if (deal.imageUrl) {
      const res = await fetch('https://graph.facebook.com/v19.0/' + pageId + '/photos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: deal.imageUrl, caption: message, access_token: pageToken }),
      });
      const data = await res.json();
      if (data.error) {
        await fetch('https://graph.facebook.com/v19.0/' + pageId + '/feed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, link: deal.url, access_token: pageToken }),
        });
      }
    } else {
      await fetch('https://graph.facebook.com/v19.0/' + pageId + '/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, link: deal.url, access_token: pageToken }),
      });
    }
    return true;
  } catch (e) {
    console.error('Facebook post failed:', e.message);
    return false;
  }
}

export default async (req, context) => {
  const queueStore = getStore("deal-queue");
  const submissionsStore = getStore("submissions");

  let queue = [];
  try { queue = await queueStore.get('queue', { type: 'json' }) || []; } catch (e) { queue = []; }

  if (queue.length === 0) {
    return new Response(JSON.stringify({ success: true, message: 'Queue is empty' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const deal = queue.shift();

  if (deal.store === 'amazon' && deal.asin) {
    const scraped = await scrapeAmazonImage(deal.asin);
    if (scraped) {
      deal.title = scraped.title || deal.title;
      deal.price = deal.price || scraped.price;
      deal.imageUrl = scraped.image || deal.imageUrl;
    }
    if (!deal.imageUrl) {
      deal.imageUrl = 'https://images-na.ssl-images-amazon.com/images/P/' + deal.asin + '.01.LZZZZZZZ.jpg';
    }
  }

  const telegramOk = await postToTelegram(deal);
  const facebookOk = await postToFacebook(deal);

  const submission = {
    id: deal.id,
    title: deal.title,
    price: deal.price || null,
    originalPrice: deal.originalPrice || null,
    discount: deal.discount || null,
    url: deal.url,
    imageUrl: deal.imageUrl || null,
    discountCode: deal.promoCode || null,
    source: 'email',
    store: deal.store || 'amazon',
    status: 'approved',
    sponsored: false,
    createdAt: new Date().toISOString(),
    expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };

  await submissionsStore.setJSON(deal.id, submission);

  let index = [];
  try { index = await submissionsStore.get('index', { type: 'json' }) || []; } catch (e) { index = []; }
  index.unshift(deal.id);
  await submissionsStore.setJSON('index', index);

  await queueStore.setJSON('queue', queue);

  return new Response(JSON.stringify({
    success: true,
    posted: deal.title,
    imageUrl: deal.imageUrl,
    telegramOk,
    facebookOk,
    queueRemaining: queue.length,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '*/5 * * * *',
};
