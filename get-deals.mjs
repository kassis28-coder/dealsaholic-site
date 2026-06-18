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
