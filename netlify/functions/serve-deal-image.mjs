// serve-deal-image.mjs
// Serves product images stored in Netlify Blobs.
// URL: GET /api/deal-image?id={asin_or_submissionId}

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return new Response(JSON.stringify({ error: "Missing id parameter" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const store = getStore("deal-images");
    const blob = await store.get(id, { type: "arrayBuffer" });

    if (!blob || blob.byteLength === 0) {
      return new Response("Image not found", { status: 404 });
    }

    // Read content-type from metadata
    const meta = await store.getMetadata(id);
    const contentType = meta?.metadata?.contentType || "image/jpeg";

    return new Response(blob, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=604800, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error(`[serve-deal-image] Error for id=${id}:`, err.message);
    return new Response("Image not found", { status: 404 });
  }
};

export const config = { path: "/api/deal-image" };
