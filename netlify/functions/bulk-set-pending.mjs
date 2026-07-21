import { getStore } from "@netlify/blobs";

export default async (req) => {
  try {
    const store = getStore("submissions");
    const index = await store.get("index", { type: "json" });
    if (!Array.isArray(index)) {
      return new Response(JSON.stringify({ error: "No index found" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let updated = 0, skipped = 0, errors = 0;
    const BATCH = 10;
    for (let i = 0; i < index.length; i += BATCH) {
      const batch = index.slice(i, i + BATCH);
      await Promise.all(batch.map(async (id) => {
        try {
          const record = await store.get(id, { type: "json" });
          if (!record) { skipped++; return; }
          const created = new Date(record.createdAt || record.submittedAt).getTime();
          if (created < cutoff) { skipped++; return; }
          if (record.source !== 'email') { skipped++; return; }
          record.status = 'pending';
          record.updatedAt = new Date().toISOString();
          await store.set(id, JSON.stringify(record));
          updated++;
        } catch (e) { errors++; }
      }));
    }
    return new Response(JSON.stringify({ success: true, updated, skipped, errors }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/bulk-set-pending" };
