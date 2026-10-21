import { getStore } from "@netlify/blobs";

// Same garbage detection as get-deals.mjs — keeps both in sync.
const GARBAGE_TITLE_RE = /^(?:the response was|message not delivered|undelivered mail|auto.?reply|delivery status|mail delivery|failure notice|returned mail|amazon deal|no title|untitled)\b/i;

function isGarbageSubmission(record) {
  const title = (record.productTitle || record.title || '').trim();
  if (!title || title.length < 8) return true;
  if (GARBAGE_TITLE_RE.test(title)) return true;
  const url = record.productUrl || record.url || '';
  if (!url) return true;
  return false;
}

export default async (req, context) => {
  const store = getStore("submissions");

  let index = [];
  try { index = await store.get('index', { type: 'json' }) || []; } catch (e) { index = []; }

  const now = new Date();
  const removedIds = [];

  // Bound parallel storage reads instead of waiting for thousands of network
  // round trips in sequence. Preserve the existing deletion eligibility rules.
  const uniqueIds = [...new Set(index)];
  const processRecord = async (id) => {
    try {
      const record = await store.get(id, { type: 'json' });
      if (!record) { removedIds.push(id); return; }

      // Remove garbage / error-message submissions permanently
      if (isGarbageSubmission(record)) {
        await store.delete(id);
        removedIds.push(id);
        return;
      }

      // Remove if expired
      if (record.expiresOn && new Date(record.expiresOn) < now) {
        await store.delete(id);
        removedIds.push(id);
        return;
      }

      // Remove if older than 7 days and no expiry set
      if (!record.expiresOn && record.createdAt) {
        const age = now - new Date(record.createdAt);
        if (age > 7 * 24 * 60 * 60 * 1000) {
          await store.delete(id);
          removedIds.push(id);
          return;
        }
      }

    } catch (e) { /* Keep records when a storage read/delete fails. */ }
  };
  for (let offset = 0; offset < uniqueIds.length; offset += 50) {
    await Promise.all(uniqueIds.slice(offset, offset + 50).map(processRecord));
  }

  // Re-read before writing so imports appended during this scan are retained.
  // If this read fails, do not overwrite the live index with the old snapshot.
  const removed = new Set(removedIds);
  const currentIndex = await store.get('index', { type: 'json' });
  const keepIds = (Array.isArray(currentIndex) ? currentIndex : index).filter(id => !removed.has(id));
  if (removed.size) await store.setJSON('index', keepIds);

  return new Response(JSON.stringify({
    success: true,
    total: index.length,
    kept: keepIds.length,
    removed: removedIds.length,
    removedIds: removedIds.slice(0, 20),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = {
  schedule: '0 */6 * * *',
};
