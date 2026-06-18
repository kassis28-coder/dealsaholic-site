/**
 * Public endpoint the website calls to read today's deals.
 * Reachable at: /.netlify/functions/get-deals
 *
 * This just reads back whatever fetch-deals.mjs last saved —
 * it does not call Amazon itself, so it's fast and has no
 * credentials of its own.
 */
import { getStore } from "@netlify/blobs";

export default async () => {
  try {
    const store = getStore("deals");
    const data = await store.get("latest", { type: "json" });

    if (!data) {
      return new Response(
        JSON.stringify({
          generatedAt: null,
          deals: [],
          message: "No deals fetched yet — first scheduled run hasn't completed.",
        }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ deals: [], error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
