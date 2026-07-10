import { getStore } from "@netlify/blobs";

// ââ Env vars âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Support both naming conventions so whichever is set in Netlify Dashboard works.
const FB_PAGE_TOKEN =
  process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
const FB_PAGE_ID =
  process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ââ Facebook API helper âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function postDealToFacebook(deal) {
  if (!FB_PAGE_TOKEN || !FB_PAGE_ID) {
    throw new Error(
      "Missing Facebook env vars. Set FB_PAGE_TOKEN and FB_PAGE_ID in Netlify."
    );
  }

  const caption = buildCaption(deal);
  const imageUrl = deal.image || deal.imageUrl || null;

  if (imageUrl) {
    console.log(`[FB] Attempting /photos for deal "${deal.title?.slice(0, 60)}"`);
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/photos`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: imageUrl,
          caption,
          access_token: FB_PAGE_TOKEN,
        }),
      }
    );
    const data = await res.json();
    console.log(`[FB] /photos response: ${JSON.stringify(data)}`);

    if (!res.ok || data.error) {
      const errMsg = data.error?.message || `HTTP ${res.status}`;
      console.error(`[FB] /photos failed (${errMsg}), falling back to /feed`);
      // Fall through to /feed below
    } else {
      return { type: "photo", id: data.id, post_id: data.post_id };
    }
  }

  // /feed fallback (also used when no image)
  console.log(`[FB] Attempting /feed for deal "${deal.title?.slice(0, 60)}"`);
  const res2 = await fetch(
    `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption,
        link: deal.url,
        access_token: FB_PAGE_TOKEN,
      }),
    }
  );
  const data2 = await res2.json();
  console.log(`[FB] /feed response: ${JSON.stringify(data2)}`);

  if (!res2.ok || data2.error) {
    throw new Error(data2.error?.message || `FB /feed HTTP ${res2.status}`);
  }
  return { type: "feed", id: data2.id };
}

function buildCaption(deal) {
  const lines = [
    "ð¥ New Deal Alert!",
    "",
    deal.title || "Amazing Deal",
  ];
  if (deal.price) {
    lines.push("");
    lines.push(
      deal.originalPrice && deal.discountPercent
        ? `ð° ${deal.price} (was ${deal.originalPrice} â ${deal.discountPercent}% off!)`
        : `ð° ${deal.price}`
    );
  }
  lines.push("");
  lines.push(`ð Shop now: ${deal.url}`);
  lines.push("");
  lines.push("#ad #deals #dealsaholic #sale #shopping");
  return lines.join("\n");
}

// ââ Main posting logic ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function postPendingDeals(limit = 5) {
  const store = getStore("submissions");

  // ââ Load already-posted IDs from dedicated facebook-posted store ââââââââââââ
  // This is the primary dedup mechanism â independent of the deal blob so it
  // survives even if the deal blob write fails or is eventually-consistent.
  const fbPostedStore = getStore("facebook-posted");
  let postedIds = [];
  try {
    const raw = await fbPostedStore.get("posted-ids");
    if (raw) postedIds = JSON.parse(raw);
    console.log(`[FB] Loaded ${postedIds.length} already-posted deal IDs`);
  } catch (e) {
    console.log("[FB] No facebook-posted store yet, starting fresh");
  }

  const { blobs } = await store.list();
  console.log(`[FB] Total blobs in submissions: ${blobs.length}`);

  const deals = [];
  for (const blob of blobs) {
    if (blob.key === "index") continue;
    try {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      const deal = JSON.parse(raw);
      if (deal.status !== "approved") continue;

      // Primary dedup: check the facebook-posted store
      if (postedIds.includes(deal.id)) {
        console.log(`[FB] Skipping ${blob.key}: in facebook-posted store`);
        continue;
      }
      // Belt-and-suspenders: also check the flag on the deal itself
      if (deal.postedToFacebook) {
        console.log(`[FB] Skipping ${blob.key}: postedToFacebook=true on deal`);
        // Sync it into the store so future runs skip faster
        if (!postedIds.includes(deal.id)) {
          postedIds.push(deal.id);
        }
        continue;
      }

      deals.push({ key: blob.key, deal });
    } catch (e) {
      console.error(`[FB] Failed to read blob "${blob.key}":`, e.message);
    }
  }

  // Persist any IDs we just synced from deal flags into the store
  // (avoids a full rebuild on the next run)
  if (postedIds.length > 0) {
    try {
      await fbPostedStore.set("posted-ids", JSON.stringify(postedIds));
    } catch (e) {
      console.error("[FB] Failed to sync posted-ids store:", e.message);
    }
  }

  console.log(`[FB] Unposted approved deals found: ${deals.length}`);

  deals.sort(
    (a, b) => new Date(b.deal.createdAt) - new Date(a.deal.createdAt)
  );

  const toPost = deals.slice(0, limit);
  const results = [];

  for (const { key, deal } of toPost) {
    console.log(`[FB] Posting deal: "${deal.title?.slice(0, 60)}" (id=${deal.id})`);
    try {
      const result = await postDealToFacebook(deal);
      const now = new Date().toISOString();

      // ââ Update the deal blob ââââââââââââââââââââââââââââââââââââââââââââââ
      deal.postedToFacebook = true;
      deal.facebookPostId = result.id;
      deal.facebookPostedAt = now;
      // Keep postedAt for backwards compatibility
      deal.postedAt = now;
      try {
        await store.set(key, JSON.stringify(deal));
        console.log(`[FB] â Deal blob updated: postedToFacebook=true facebookPostedAt=${now}`);
      } catch (writeErr) {
        // Don't fail the overall post â the facebook-posted store is the source of truth
        console.error(`[FB] â ï¸ Failed to update deal blob (deal still marked in facebook-posted store):`, writeErr.message);
      }

      // ââ Update the facebook-posted store (primary dedup) ââââââââââââââââââ
      postedIds.push(deal.id);
      if (postedIds.length > 1000) postedIds = postedIds.slice(-1000);
      await fbPostedStore.set("posted-ids", JSON.stringify(postedIds));
      console.log(`[FB] â Posted successfully: type=${result.type} id=${result.id}`);
      results.push({ title: deal.title?.slice(0, 50), ...result });
    } catch (err) {
      console.error(`[FB] â Failed to post deal "${deal.title?.slice(0, 50)}":`, err.message);
      results.push({ title: deal.title?.slice(0, 50), error: err.message });
    }
  }

  return { posted: results.filter((r) => !r.error).length, results };
}

// ââ Handler âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default async function handler(req) {
  const url = new URL(req.url);
  const password = url.searchParams.get("password");

  // Scheduled invocations have no query params â allow them through.
  // Manual HTTP triggers must supply the correct password.
  const isScheduledRun = !password && !url.searchParams.has("password");
  if (!isScheduledRun && password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(
    `[FB] post-to-facebook triggered (${isScheduledRun ? "scheduled" : "manual"})`
  );
  console.log(
    `[FB] Env check â FB_PAGE_TOKEN=${FB_PAGE_TOKEN ? "SET" : "MISSING"} FB_PAGE_ID=${FB_PAGE_ID ? "SET" : "MISSING"}`
  );

  try {
    let result;

    if (req.method === "POST" && !isScheduledRun) {
      const body = await req.json().catch(() => ({}));

      if (body.dealId) {
        const store = getStore("submissions");
        const raw = await store.get(body.dealId);
        if (!raw) {
          return new Response(JSON.stringify({ error: "Deal not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        const deal = JSON.parse(raw);
        const fbResult = await postDealToFacebook(deal);
        deal.postedToFacebook = true;
        deal.facebookPostId = fbResult.id;
        deal.facebookPostedAt = new Date().toISOString();
        deal.postedAt = deal.facebookPostedAt;
        await store.set(body.dealId, JSON.stringify(deal));

        // Also update the facebook-posted store
        const fbPostedStore = getStore("facebook-posted");
        let postedIds = [];
        try {
          const raw2 = await fbPostedStore.get("posted-ids");
          if (raw2) postedIds = JSON.parse(raw2);
        } catch (_) {}
        postedIds.push(deal.id);
        await fbPostedStore.set("posted-ids", JSON.stringify(postedIds));

        result = { posted: 1, results: [fbResult] };
      } else {
        const limit = parseInt(body.limit || "5", 10);
        result = await postPendingDeals(limit);
      }
    } else {
      result = await postPendingDeals(5);
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[FB] Unhandled error:", err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ââ Schedule: run every 15 minutes âââââââââââââââââââââââââââââââââââââââââââ
export const config = {
  schedule: "*/15 * * * *",
};
