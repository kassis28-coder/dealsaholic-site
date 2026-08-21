import { getStore } from '@netlify/blobs';
import renderDeal from './deal-meta.mjs';

function publicDeal(record, id) {
  if (!record || record.status !== 'approved') return null;
  const expiresAt = new Date(record.expiresOn).getTime();
  if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) return null;
  return {
    id,
    asin: record.asin || null,
    title: record.productTitle || record.title || '',
    image: record.image || record.photoUrl || record.imageUrl || '',
    price: record.price || '',
    originalPrice: record.originalPrice || '',
    discountPercent: record.discountPercent || record.discount || '',
    discountCode: record.discountCode || '',
    url: record.productUrl || record.url || '',
    storeType: record.storeType || record.store || 'amazon',
  };
}

export default async (req, context) => {
  const id = context?.params?.id || new URL(req.url).pathname.split('/').filter(Boolean).pop() || '';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return new Response('Deal not found', { status: 404 });

  let deal = null;
  if (id.startsWith('sub_') || id.startsWith('email-')) {
    const record = await getStore('submissions').get(id, { type: 'json' }).catch(() => null);
    deal = publicDeal(record, id);
  } else {
    const latest = await getStore('deals').get('latest', { type: 'json' }).catch(() => null);
    deal = (latest?.deals || []).find(item =>
      String(item.id || '') === id
      || String(item.asin || '').toUpperCase() === id.toUpperCase()
    ) || null;
  }

  if (!deal) return new Response('Deal not found', { status: 404 });

  const source = new URL(req.url);
  const renderUrl = new URL('https://deals-aholic.com/deal');
  const fields = {
    asin: deal.asin,
    title: deal.title || deal.productTitle,
    price: deal.price,
    original: deal.originalPrice,
    discount: deal.discountPercent,
    image: deal.image,
    code: deal.discountCode,
    store: deal.storeType || deal.store,
    url: deal.url || deal.productUrl,
    canonical: `https://deals-aholic.com/d/${encodeURIComponent(id)}${source.search}`,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined && value !== '') renderUrl.searchParams.set(key, value);
  }
  return renderDeal(new Request(renderUrl, { headers: req.headers }));
};

export const config = { path: '/d/:id' };
