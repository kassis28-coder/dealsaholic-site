import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (!id) {
    return new Response("Missing image ID", { status: 400 });
  }

  try {
    const imageStore = getStore("images");
    const { data, metadata } = await imageStore.getWithMetadata(id);

    if (!data) {
      return new Response("Image not found", { status: 404 });
    }

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": metadata?.contentType || "image/jpeg",
        "Cache-Control": "public, max-age=31536000",
      },
    });
  } catch (err) {
    return new Response("Error fetching image: " + err.message, { status: 500 });
  }
};

export const config = {
  path: "/api/get-image",
};
