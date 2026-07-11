// cleanup-facebook-posts.mjs
// One-time cleanup: delete deal posts missing promo codes from the last N hours.

const FB_PAGE_TOKEN =
  process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
const FB_PAGE_ID =
  process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Default: 10 hours. Pass ?hours=24 to extend.
const DEFAULT_HOURS = 10;

// Identify our automated deal posts by plain-text markers (no emoji â avoids encoding issues).
// A post is "ours" if it contains "New Deal Alert!" or "Shop now:".
// A post is "bad" if it is ours AND is missing a promo code line ("Code:").
function isBadPost(message) {
  if (!message) return false;
  const isDealPost = message.includes("New Deal Alert!") || message.includes("Shop now:");
  if (!isDealPost) return false;          // not our automated post â skip
  const hasCode = message.includes("Code:") ||
                  message.toLowerCase().includes("coupon") ||
                  message.toLowerCase().includes("promo code");
  return !hasCode;                         // bad if no promo code info
}

async function getRecentPosts(hours) {
  if (!FB_PAGE_TOKEN || !FB_PAGE_ID) {
    throw new Error("Missing FB_PAGE_TOKEN or FB_PAGE_ID env vars");
  }
  const since = Math.floor((Date.now() - hours * 3600 * 1000) / 1000);
  const url =
    `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed` +
    `?fields=id,message,created_time,story` +
    `&since=${since}&limit=100&access_token=${FB_PAGE_TOKEN}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(`FB API: ${data.error.message}`);
  return data.data || [];
}

async function deletePost(postId) {
  const res = await fetch(
    `https://graph.facebook.com/v19.0/${postId}?access_token=${FB_PAGE_TOKEN}`,
    { method: "DELETE" }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.success;
}

export default async function handler(req) {
  const url      = new URL(req.url);
  const password = url.searchParams.get("password");
  const dryRun   = url.searchParams.get("dry") === "1";
  const hours    = parseInt(url.searchParams.get("hours") || String(DEFAULT_HOURS), 10);
  const deleteAll = url.searchParams.get("all") === "1"; // delete ALL deal posts, not just missing-code
  const limit     = parseInt(url.searchParams.get("limit") || "25", 10); // max posts to delete per call

  if (password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[CLEANUP] dry=${dryRun} hours=${hours} deleteAll=${deleteAll}`);

  try {
    const posts = await getRecentPosts(hours);
    console.log(`[CLEANUP] Found ${posts.length} posts in last ${hours}h`);

    const toDelete = [];
    const toKeep   = [];

    for (const post of posts) {
      const msg = post.message || post.story || "";
      const isDeal = msg.includes("New Deal Alert!") || msg.includes("Shop now:");
      const bad    = deleteAll ? isDeal : isBadPost(msg);

      const entry = {
        id: post.id,
        created_time: post.created_time,
        preview: msg.slice(0, 150),
        reason: bad
          ? (deleteAll ? "all-deal-posts" : "missing-promo-code")
          : null,
      };
      if (bad) toDelete.push(entry);
      else     toKeep.push(entry);
    }

    console.log(`[CLEANUP] to_delete=${toDelete.length} to_keep=${toKeep.length} limit=${limit}`);

    const batch   = toDelete.slice(0, limit); // apply limit
    const deleted = [];
    const failed  = [];

    if (!dryRun) {
      for (const post of batch) {
        try {
          await deletePost(post.id);
          console.log(`[CLEANUP] DELETED ${post.id}: "${post.preview.slice(0, 60)}"`);
          deleted.push(post);
        } catch (err) {
          console.error(`[CLEANUP] FAILED ${post.id}: ${err.message}`);
          failed.push({ ...post, error: err.message });
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        dry_run: dryRun,
        hours_checked: hours,
        total_posts: posts.length,
        to_delete_total: toDelete.length,
        to_delete: dryRun ? toDelete.slice(0, limit) : batch,
        deleted: dryRun ? [] : deleted,
        failed: dryRun ? [] : failed,
        kept_count: toKeep.length,
        remaining: Math.max(0, toDelete.length - limit),
      }, null, 2),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("[CLEANUP] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
