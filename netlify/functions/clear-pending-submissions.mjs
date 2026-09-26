import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { password } = await req.json();
    if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const store = getStore('submissions');
    const index = await store.get('index', { type: 'json', consistency: 'strong' }) || [];
    if (!Array.isArray(index)) throw new Error('Invalid submissions index');
    const removed = new Set();
    const failures = [];
    for (let offset = 0; offset < index.length; offset += 100) {
      const batch = index.slice(offset, offset + 100);
      await Promise.all(batch.map(async (id) => {
        try {
          const record = await store.get(id, { type: 'json', consistency: 'strong' });
          if (!record) { removed.add(id); return; }
          if (record.status !== 'pending') return;
          await store.delete(id);
          removed.add(id);
        } catch (error) {
          failures.push({ id, error: error.message });
        }
      }));
    }
    await store.setJSON('index', index.filter(id => !removed.has(id)));
    return Response.json({ deleted: removed.size, failed: failures.length, failures: failures.slice(0, 10) });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
};

export const config = { path: '/api/clear-pending-submissions' };
