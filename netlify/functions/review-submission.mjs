/**
 * Approves or rejects a pending seller submission. Requires the
 * admin password — this is NOT a public endpoint.
 *
 * Reachable at: /.netlify/functions/review-submission
 *
 * Required environment variables:
 *   ADMIN_PASSWORD
 */

import { getStore } from "@netlify/blobs";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async (req) => {
  try {
    const body = await req.json();
    const { password, submissionId, action, updatedUrl } = body;

    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      return new Response(
        JSON.stringify({ error: "Incorrect password." }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    if (!submissionId || !["approve", "reject"].includes(action)) {
      return new Response(
        JSON.stringify({ error: "Missing submissionId or invalid action." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const store = getStore("submissions");
    const record = await store.get(submissionId, { type: "json" });

    if (!record) {
      return new Response(
        JSON.stringify({ error: "Submission not found." }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (updatedUrl && typeof updatedUrl === "string" && updatedUrl.trim() !== "") {
      record.productUrl = updatedUrl.trim();
      record.needsAffiliateLink = false; // admin has supplied the real link
    }

    record.status = action === "approve" ? "approved" : "rejected";
    record.reviewedAt = new Date().toISOString();

    await store.setJSON(submissionId, record);

    return new Response(JSON.stringify({ ok: true, status: record.status }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("review-submission failed:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
