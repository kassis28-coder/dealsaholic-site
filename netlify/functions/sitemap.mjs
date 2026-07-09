import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("deals");

  const data = await store.get("latest", { type: "json" });

  return new Response(
    JSON.stringify({
      exists: !!data,
      keys: data ? Object.keys(data) : [],
      dealCount: data?.deals?.length || 0,
      sample: data?.deals?.[0] || null
    }, null, 2),
    {
      headers: {
        "Content-Type": "application/json"
      }
    }
  );
};
