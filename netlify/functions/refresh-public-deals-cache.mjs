import { getStore } from "@netlify/blobs";
import { rebuildPublicFeed } from "./get-deals.mjs";

// Rebuild the expensive public catalog away from visitor requests. The public
// endpoint always serves the most recent durable snapshot immediately, while
// this scheduled function scans submissions and refreshes that snapshot.
export default async function refreshPublicDealsCache() {
  const startedAt = Date.now();
  const publicCache = getStore("public-deals-cache");
  const payload = await rebuildPublicFeed(publicCache);

  console.log(
    `Public deals cache refreshed | deals=${payload.deals?.length || 0} | durationMs=${Date.now() - startedAt}`
  );

  return new Response(
    JSON.stringify({
      ok: true,
      deals: payload.deals?.length || 0,
      generatedAt: payload.generatedAt || null,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

export const config = {
  schedule: "*/5 * * * *",
};
