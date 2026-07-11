import { getStore } from "@netlify/blobs";

// â ï¸  FACEBOOK POSTING DISABLED FOR MAINTENANCE â ï¸
// Disabled 2026-07-11. Root cause: race condition causes same deal to be posted
// repeatedly. Will be re-enabled after proper atomic dedup is deployed.
export default async function handler(req) {
  console.log("[FB] DISABLED: Facebook posting is temporarily disabled");
  return new Response(
    JSON.stringify({
      error: "Facebook posting disabled for maintenance",
      status: "disabled",
    }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

export const config = {};
