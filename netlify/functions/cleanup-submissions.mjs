import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const store = getStore("submissions");
  
  let index = [];
  try { index = await store.get('index', { type: 'json' }) || []; } catch (e) { index = []; }

  const now = new Date();
  const keepIds = [];
  const removedIds = [];

  for (const id of index) {
    try {
      const record = await store.get(id, { type: 'json' });
      if (!record) { removedIds.push(id); continue; }

      // Remove if expired
      if (record.expiresOn && new Date(record.expiresOn) < now) {
        await store.delete(id);
        removedIds.push(id);
        continue;
      }

      // Remove if older than 7 days and no expiry set
      if (!record.expiresOn && record.createdAt) {
        const age = now - new Date(record.createdAt);
        if (age > 7 * 24 * 60 * 60 * 1000) {
          await store.delete(id);
          removedIds.push(id);
          continue;
        }
      }

      keepIds.push(id);
    } catch (e) {
      keepIds.push(id);
    }
  }

  // Update index with only valid deals
  await store.setJSON('index', keepIds);

  return new Response(JSON.stringify({
    success: true,
    total: index.length,
    kept: keepIds.length,
    removed: removedIds.length,
    removedIds: removedIds.slice(0, 20),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '0 * * * *',
};
