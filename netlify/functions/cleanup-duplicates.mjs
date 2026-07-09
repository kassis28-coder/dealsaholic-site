import { getStore } from "@netlify/blobs";

/**
 * cleanup-duplicates.mjs
 *
 * On-demand cleanup of duplicate deals in the submissions store.
 * - Groups all submissions by ASIN (primary) then normalized URL (fallback).
 * - Keeps the newest / most complete record per group.
 * - Deletes all duplicates.
 * - Rebuilds the main index, asin-index, and url-index from scratch.
 *
 * Trigger:  GET /.netlify/functions/cleanup-duplicates?secret=YOUR_CLEANUP_SECRET
 * Set CLEANUP_SECRET as a Netlify environment variable to protect this endpoint.
 */

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return url.toLowerCase().trim();
  }
}

function scoreDeal(deal) {
  let score = 0;
  if (deal.image || deal.imageUrl) score += 4;
  if (deal.price) score += 3;
  if (deal.title && deal.title.length > 20) score += 2;
  if (deal.discountPercent || deal.discount) score += 1;
  if (deal.discountCode || deal.promoCode) score += 1;
  return score;
}

export default async (req) => {
  const reqUrl = new URL(req.url);
  const secret = reqUrl.searchParams.get('secret');
  if (!secret || secret !== process.env.CLEANUP_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  const submissionsStore = getStore("submissions");

  let index = [];
  try { index = await submissionsStore.get('index', { type: 'json' }) || []; } catch {}

  if (index.length === 0) {
    return new Response(JSON.stringify({ message: 'No deals in index', removed: 0 }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  console.log(`[cleanup-duplicates] Loading ${index.length} deal records...`);

  const allDeals = [];
  for (const id of index) {
    try {
      const deal = await submissionsStore.get(id, { type: 'json' });
      if (deal) allDeals.push(deal);
    } catch {}
  }

  console.log(`[cleanup-duplicates] Loaded ${allDeals.length} valid records.`);

  const byAsin = new Map();
  const noAsin = [];

  for (const deal of allDeals) {
    const asin = deal.asin;
    if (asin && /^[A-Z0-9]{10}$/i.test(asin)) {
      if (!byAsin.has(asin)) byAsin.set(asin, []);
      byAsin.get(asin).push(deal);
    } else {
      noAsin.push(deal);
    }
  }

  const byUrl = new Map();
  const noKey = [];

  for (const deal of noAsin) {
    const key = normalizeUrl(deal.url || deal.productUrl || '');
    if (key) {
      if (!byUrl.has(key)) byUrl.set(key, []);
      byUrl.get(key).push(deal);
    } else {
      noKey.push(deal);
    }
  }

  const toDelete = new Set();
  const survivors = [];
  const asinIndex = {};
  const urlIndex = {};

  function pickBest(deals, logKey) {
    if (deals.length === 1) return deals[0];
    deals.sort((a, b) => {
      const diff = scoreDeal(b) - scoreDeal(a);
      if (diff !== 0) return diff;
      return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
    });
    const keeper = deals[0];
    for (let i = 1; i < deals.length; i++) {
      toDelete.add(deals[i].id);
      console.log(`[cleanup-duplicates] REMOVED DUPLICATE | Key: ${logKey} | Removed ID: ${deals[i].id} | Kept ID: ${keeper.id}`);
    }
    return keeper;
  }

  for (const [asin, deals] of byAsin) {
    const keeper = pickBest(deals, `ASIN:${asin}`);
    survivors.push(keeper);
    asinIndex[asin] = keeper.id;
    const normUrl = normalizeUrl(keeper.url || keeper.productUrl || '');
    if (normUrl) urlIndex[normUrl] = keeper.id;
  }

  for (const [normUrl, deals] of byUrl) {
    const keeper = pickBest(deals, `URL:${normUrl}`);
    survivors.push(keeper);
    urlIndex[normUrl] = keeper.id;
  }

  for (const deal of noKey) {
    survivors.push(deal);
  }

  let deleteErrors = 0;
  for (const id of toDelete) {
    try {
      await submissionsStore.delete(id);
    } catch (e) {
      console.error(`[cleanup-duplicates] Failed to delete ${id}:`, e.message);
      deleteErrors++;
    }
  }

  survivors.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  const newIndex = survivors.map(d => d.id);

  await submissionsStore.setJSON('index', newIndex);
  await submissionsStore.setJSON('asin-index', asinIndex);
  await submissionsStore.setJSON('url-index', urlIndex);

  console.log(`[cleanup-duplicates] Done. Removed: ${toDelete.size}, Remaining: ${newIndex.length}`);

  return new Response(JSON.stringify({
    success: true,
    originalCount: allDeals.length,
    removed: toDelete.size,
    deleteErrors,
    remaining: newIndex.length,
    asinIndexSize: Object.keys(asinIndex).length,
    urlIndexSize: Object.keys(urlIndex).length,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
