import { getStore } from "@netlify/blobs";

// ââ Env vars ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const FB_PAGE_TOKEN =
  process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
const FB_PAGE_ID =
  process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// How far back to look (10 hours in ms)
const LOOKBACK_MS = 10 * 60 * 60 * 1000;

// A post is "bad" (missing deal info) if its message lacks a price line AND
// lacks a promo code line. We delete posts that look like they came from the
// broken caption builder (no ð° price, no ð· Code:, no âï¸ coupon).
function isBadPost(message = "") {
  const hasPrice     = /ð°/.test(message);
  const hasCode      = /ð·\s*Code:/i.test(message) || /âï¸/.test(message);
  const hasShopLink  = /ð/.test(message);
  // Only target posts that look like our deal posts (have the shop link emoji)
  // but are missing price AND promo code info.
  if (!hasShopLink) return false;          // not our post
  if (hasPrice && hasCode) return false;   // looks complete
  return true;                             // missing price or promo code
}

async function getRecentPagePosts() {
  if (!FB_PAGE_TOKEN || !FB_PAGE_ID) {
    throw new Error("Missing FB_PAGE_TOKEN or FB_PAGE_ID env vars");
  }

  const since = Math.floor((Date.now() - LOOKBACK_MS) / 1000);
  const url = `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed` +
    `?fields=id,message,created_time,story` +
    `&since=${since}` +
    `&limit=100` +
    `&access_token=${FB_PAGE_TOKEN}`;

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
  if (data.error) throw new Error(`Delete ${postId}: ${data.error.message}`);
  return data.success;
}

export default async function handler(req) {
  // Require admin password â never run as scheduled
  const url      = new URL(req.url);
  const password = url.searchParams.get("password");
  const dryRun   = url.searchParams.get("dry") === "1";

  if (password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[CLEANUP] Starting â dry_run=${dryRun} lookback=10h`);

  try {
    const posts = await getRecentPagePosts();
    console.log(`[CLEANUP] Found ${posts.length} posts in last 10h`);

    const toDelete = [];
    const toKeep   = [];

    for (const post of posts) {
      const bad = isBadPost(post.message);
      const entry = {
        id: post.id,
        created_time: post.created_time,
        preview: (post.message || post.story || "").slice(0, 120),
        reason: bad ? "missing-price-or-promo-code" : null,
      };
      if (bad) toDelete.push(entry);
      else     toKeep.push(entry);
    }

    console.log(`[CLEANUP] to_delete=${toDelete.length} to_keep=${toKeep.length}`);

    const deleted  = [];
    const failed   = [];

    if (!dryRun) {
      for (const post of toDelete) {
        try {
          await deletePost(post.id);
          console.log(`[CLEANUP] â Deleted ${post.id}: "${post.preview.slice(0, 60)}"`);
          deleted.push(post);
        } catch (err) {
          console.error(`[CLEANUP] â Failed to delete ${post.id}: ${err.message}`);
          failed.push({ ...post, error: err.message });
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      dry_run: dryRun,
      total_posts_checked: posts.length,
      to_delete: toDelete,
      deleted: dryRun ? [] : deleted,
      failed: dryRun ? [] : failed,
      kept: toKeep,
    }, null, 2), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[CLEANUP] Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}
