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
      const existingIndex = await store.get("index", { type: "json" });
      if (Array.isArray(existingIndex)) index = existingIndex;
    } catch {
      // No submissions yet.
    }

    const submissions = [];
    for (const id of index) {
      try {
        const record = await store.get(id, { type: "json" });
        if (record) submissions.push(record);
      } catch {
        // Skip any record that fails to load rather than failing the whole list.
      }
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
