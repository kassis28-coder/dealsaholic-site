import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';

// Inject in-memory storage only; these tests never call live publishers or stores.
let moduleId = 0;
async function loadFunction(name, getStore) {
  const key = `creditTestStore${++moduleId}`;
  globalThis[key] = getStore;
  const source = (await fs.readFile(new URL(`../netlify/functions/${name}.mjs`, import.meta.url), 'utf8'))
    .replace('import { getStore } from "@netlify/blobs";', `const getStore = globalThis.${key};`);
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`); }
  finally { delete globalThis[key]; }
}

const request = () => new Request('https://example.test/api/deals');
const valid = (extra = {}) => ({ title: 'Valid kitchen product', url: 'https://example.test/product', image: 'https://example.test/image.jpg', ...extra });

test('visitor reuses a 20-minute-old snapshot without scanning submissions', async () => {
  const snapshot = { cachedAt: Date.now() - 20 * 60_000, payload: { deals: [valid({ id: 'one' })] } };
  const { default: handler } = await loadFunction('get-deals', name => {
    assert.equal(name, 'public-deals-cache');
    return { get: async () => snapshot };
  });
  const response = await handler(request());
  assert.equal((await response.json()).deals[0].id, 'one');
  assert.match(response.headers.get('Netlify-CDN-Cache-Control'), /max-age=60,/);
});

test('cached responses omit expired deals and old Amazon imports, including home view', async () => {
  const snapshot = { cachedAt: Date.now(), payload: { deals: [
    valid({ id: 'live', expiresOn: '2099-01-01' }),
    valid({ id: 'expired', expiresOn: '2000-01-01' }),
    valid({ id: 'old-amazon', fetchedAt: '2000-01-01' }),
  ] } };
  const { default: handler } = await loadFunction('get-deals', () => ({ get: async () => snapshot }));
  for (const suffix of ['', '?view=home']) {
    const response = await handler(new Request(`https://example.test/api/deals${suffix}`));
    assert.deepEqual((await response.json()).deals.map(d => d.id), ['live']);
  }
});

test('concurrent cold requests share a rebuild and retain approval, image and expiry filters', async () => {
  let indexReads = 0;
  let cacheWrites = 0;
  const records = {
    live: valid({ id: 'live', status: 'approved', expiresOn: '2099-01-01' }),
    expired: valid({ id: 'expired', status: 'approved', expiresOn: '2000-01-01' }),
    pending: valid({ id: 'pending', status: 'pending' }),
    noimage: valid({ id: 'noimage', status: 'approved', image: '' }),
  };
  const stores = {
    'public-deals-cache': { get: async () => null, setJSON: async () => { cacheWrites++; } },
    submissions: { get: async key => {
      if (key !== 'index') return records[key];
      indexReads++;
      await new Promise(resolve => setImmediate(resolve));
      return Object.keys(records);
    } },
    deals: { get: async () => ({ deals: [] }) },
    'flagged-deals': { list: async () => ({ blobs: [] }) },
  };
  const { default: handler } = await loadFunction('get-deals', name => stores[name]);
  const responses = await Promise.all([handler(request()), handler(request()), handler(request())]);
  for (const response of responses) {
    const payload = await response.json();
    assert.deepEqual(payload.deals.map(d => d.id), ['live']);
    assert.equal(payload.deals[0].expiresOn, '2099-01-01');
  }
  assert.equal(indexReads, 1);
  assert.equal(cacheWrites, 1);
});

test('scheduler failure triggers hourly fallback and failed rebuilds can be retried', async () => {
  let fail = true;
  let builds = 0;
  const snapshot = { cachedAt: Date.now() - 61 * 60_000, payload: { deals: [valid({ id: 'saved' })] } };
  const stores = {
    'public-deals-cache': { get: async () => snapshot, setJSON: async () => {} },
    deals: { get: async () => { builds++; if (fail) throw new Error('storage unavailable'); return { deals: [] }; } },
    submissions: { get: async () => [] },
    'flagged-deals': { list: async () => ({ blobs: [] }) },
  };
  const { default: handler } = await loadFunction('get-deals', name => stores[name]);
  assert.equal((await (await handler(request())).json()).deals[0].id, 'saved');
  fail = false;
  assert.deepEqual((await (await handler(request())).json()).deals, []);
  assert.equal(builds, 2);
});

test('cleanup uses bounded parallel reads, preserves publishing flags and newly imported IDs', async () => {
  let indexReads = 0;
  let active = 0;
  let maxActive = 0;
  let writtenIndex;
  const deleted = [];
  const live = valid({ facebookPosted: true, telegramPosted: true });
  const ids = Array.from({ length: 120 }, (_, i) => `live-${i}`);
  const store = {
    get: async key => {
      if (key === 'index') return ++indexReads === 1 ? [...ids, 'expired', 'unreadable', 'delete-fails'] : [...ids, 'expired', 'unreadable', 'delete-fails', 'new-import'];
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (key === 'unreadable') throw new Error('read failed');
      if (key === 'expired' || key === 'delete-fails') return valid({ expiresOn: '2000-01-01' });
      return live;
    },
    delete: async key => { if (key === 'delete-fails') throw new Error('delete failed'); deleted.push(key); },
    setJSON: async (key, value) => { assert.equal(key, 'index'); writtenIndex = value; },
  };
  const { default: handler, config } = await loadFunction('cleanup-submissions', () => store);
  const response = await handler(request());
  assert.equal((await response.json()).removed, 1);
  assert.deepEqual(deleted, ['expired']);
  assert.equal(writtenIndex.includes('expired'), false);
  assert.ok(writtenIndex.includes('new-import'));
  assert.ok(writtenIndex.includes('unreadable'));
  assert.ok(writtenIndex.includes('delete-fails'));
  assert.ok(maxActive > 1 && maxActive <= 50);
  assert.equal(live.facebookPosted, true);
  assert.equal(live.telegramPosted, true);
  assert.equal(config.schedule, '0 */6 * * *');
});

test('cleanup never overwrites the index if the final fresh read fails', async () => {
  let reads = 0;
  let writes = 0;
  const { default: handler } = await loadFunction('cleanup-submissions', () => ({
    get: async key => {
      if (key !== 'index') return null;
      if (++reads > 1) throw new Error('fresh index unavailable');
      return ['missing'];
    },
    setJSON: async () => { writes++; },
  }));
  await assert.rejects(() => handler(request()), /fresh index unavailable/);
  assert.equal(writes, 0);
});
