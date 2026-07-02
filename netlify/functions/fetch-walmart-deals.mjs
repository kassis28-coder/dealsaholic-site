import { getStore } from "@netlify/blobs";

export default async function handler(req) {
    const url = new URL(req.url);
    const password = url.searchParams.get("password");
    if (!password || password !== process.env.ADMIN_PASSWORD) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
                  status: 401,
                  headers: { "Content-Type": "application/json" },
          });
    }

  const store = getStore("submissions");
    const { blobs } = await store.list();

  return new Response(
        JSON.stringify({ success: true, message: "Walmart function working!", existing: blobs.length }),
    { headers: { "Content-Type": "application/json" } }
      );
}

export const config = {
    schedule: "0 */3 * * *",
};
