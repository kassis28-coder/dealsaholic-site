/**
 * Returns all seller submissions (pending, approved, rejected) for
 * the admin review page. Requires the admin password to be passed
 * in the request body — this is NOT a public endpoint.
 *
 * Reachable at: /.netlify/functions/get-submissions
 *
 * Required environment variables:
 *   ADMIN_PASSWORD
 */

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async (req) => {
  try {
    const body = await req.json();

    if (!ADMIN_PASSWORD || body.password !== ADMIN_PASSWORD) {
      return new Response(
        JSON.stringify({ error: "Incorrect password." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    const store = getStore("submissions");

    let index = [];
    try {
      // Admin refreshes must show the just-saved record, not an edge-cached
      // copy of the index. This endpoint is admin-only, so correctness wins.
      const existingIndex = await store.get("index", { type: "json", consistency: "strong" });
      if (Array.isArray(existingIndex)) index = existingIndex;
    } catch {
      // No submissions yet.
    }

    // Strong reads are necessary here so a refresh shows the latest admin edit.
    // Reading hundreds of records one-by-one, however, takes longer than the
    // browser request timeout. Read a small group in parallel instead.
    const submissions = [];
    const batchSize = 25;
    for (let offset = 0; offset < index.length; offset += batchSize) {
      const batch = index.slice(offset, offset + batchSize);
      const records = await Promise.all(batch.map(async (id) => {
        try {
          return await store.get(id, { type: "json", consistency: "strong" });
        } catch {
          // Skip a single unreadable record rather than failing the whole list.
          return null;
        }
      }));
      submissions.push(...records.filter(Boolean));
    }

    submissions.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    return new Response(JSON.stringify({ submissions }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("get-submissions failed:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
