import { getStore } from "@netlify/blobs";

// ââ Env vars âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Support both naming conventions â whichever is set in Netlify Dashboard works.
const FB_PAGE_TOKEN =
  process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
const FB_PAGE_ID =
  process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Max consecutive API failures before a deal is permanently skipped.
const MAX_FAIL_COUNT = 3;
// Ring-buffer size for the facebook-posted dedup store.
const MAX_POSTED_IDS = 2000;

// ââ Caption builder âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// Field-name mapping â different ingest paths store under different names:
//   submit-email-deal.mjs  â imageUrl, discount (string %), discountCode, couponPct
//   post-queued-deal.mjs   â image, discountPercent (number), discountCode
function buildCaption(deal) {
  // Normalise field variants
  const imageUrl   = deal.image || deal.imageUrl || null;           // used by caller too
  const discountPct = deal.discountPercent || deal.discount || null; // "40" or 40
  const couponPct   = deal.couponPct || null;

  const lines = ["ð¥ New Deal Alert!", "", deal.title || "Amazing Deal"];

  // Price line
  if (deal.price) {
    lines.push("");
    if (deal.originalPrice && discountPct) {
      lines.push(`ð° ${deal.price} (was ${deal.originalPrice} â ${discountPct}% off!)`);
    } else if (discountPct) {
      lines.push(`ð° ${deal.price} â ${discountPct}% off!`);
    } else {
      lines.push(`ð° ${deal.price}`);
    }
  } else if (discountPct) {
    lines.push("", `ð· ${discountPct}% off!`);
  }

  // Coupon % (clip coupon deals)
  if (couponPct) lines.push(`âï¸ Extra ${couponPct}% coupon â clip at checkout`);

  // Promo code
  if (deal.discountCode) lines.push(`ð· Code: ${deal.discountCode}`);

  lines.push("", `ð Shop now: ${deal.url}`, "", "#ad #deals #dealsaholic #sale #shopping");
  return lines.join("\n");
}

// ââ Facebook API caller âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function callFacebookApi(deal) {
  if (!FB_PAGE_TOKEN || !FB_PAGE_ID) {
    throw new Error(
      "Missing Facebook env vars. Set FB_PAGE_TOKEN (or FACEBOOK_PAGE_TOKEN) " +
      "and FB_PAGE_ID (or FACEBOOK_PAGE_ID) in Netlify."
    );
  }

  const caption = buildCaption(deal);
  // Both ingest paths use different field names â handle both.
  const imageUrl = deal.image || deal.imageUrl || null;

  if (imageUrl) {
    console.log(`[FB] /photos attempt â deal_id=${deal.id} image="${imageUrl.slice(0, 80)}"`);
    const res = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/photos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: imageUrl, caption, access_token: FB_PAGE_TOKEN }),
    });
    const data = await res.json();
    console.log(`[FB] /photos response: ${JSON.stringify(data)}`);
    if (!res.ok || data.error) {
      console.warn(`[FB] /photos failed (${data.error?.message || res.status}), falling back to /feed`);
    } else {
      return { type: "photo", id: data.id, post_id: data.post_id };
    }
  }

  console.log(`[FB] /feed attempt â deal_id=${deal.id}`);
  const res2 = await fetch(`https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: caption, link: deal.url, access_token: FB_PAGE_TOKEN }),
  });
  const data2 = await res2.json();
  console.log(`[FB] /feed response: ${JSON.stringify(data2)}`);
  if (!res2.ok || data2.error) {
    throw new Error(data2.error?.message || `FB /feed HTTP ${res2.status}`);
  }
  return { type: "feed", id: data2.id };
}

// ââ Dedup store helpers âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function loadPostedIds(store) {
  try {
    const raw = await store.get("posted-ids");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        console.log(`[FB] Loaded ${parsed.length} already-posted IDs`);
        return parsed;
      }
    }
  } catch (e) {
    console.warn("[FB] Could not load posted-ids:", e.message);
  }
  console.log("[FB] No posted-ids yet, starting fresh");
  return [];
}

async function savePostedIds(store, ids) {
  const toSave = ids.length > MAX_POSTED_IDS ? ids.slice(-MAX_POSTED_IDS) : ids;
  await store.set("posted-ids", JSON.stringify(toSave));
  console.log(`[FB] Saved ${toSave.length} posted IDs`);
}

// ââ Deal filter âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function shouldSkipDeal(deal, postedIds, now) {
  if (deal.status !== "approved") return "not-approved";
  if (deal.id && postedIds.includes(deal.id)) return "in-posted-store";
  if (deal.postedToFacebook === true) return "postedToFacebook-flag";
  if ((deal.facebookFailCount || 0) >= MAX_FAIL_COUNT) return "too-many-failures";
  if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) return "expired";
  if (!deal.title || !deal.url) return "missing-title-or-url";
  if (!deal.discountCode && !deal.couponPct) return "no-promo-code"; // require a promo/coupon code
  return null;
}

// ââ Post the next pending deal ââââââââââââââââââââââââââââââââââââââââââââââââ
async function postNextDeal() {
  const submissionsStore = getStore("submissions");
  const fbPostedStore = getStore("facebook-posted");
  const postedIds = await loadPostedIds(fbPostedStore);

  let blobs;
  try {
    ({ blobs } = await submissionsStore.list());
  } catch (e) {
    console.error("[FB] FATAL: Failed to list submissions:", e.message);
    return { error: e.message };
  }
  console.log(`[FB] Total blobs in submissions: ${blobs.length}`);

  const now = Date.now();
  const candidates = [];
  let syncedIds = false;

  for (const blob of blobs) {
    if (blob.key === "index") continue;
    try {
      const raw = await submissionsStore.get(blob.key);
      if (!raw) continue;
      const deal = JSON.parse(raw);

      const skipReason = shouldSkipDeal(deal, postedIds, now);
      if (skipReason) {
        if (skipReason !== "not-approved") {
          console.log(`[FB] Skip ${blob.key} (${skipReason}): "${deal.title?.slice(0, 40)}"`);
        }
        // Sync postedToFacebook flag deals into the store for faster future skips
        if (skipReason === "postedToFacebook-flag" && deal.id && !postedIds.includes(deal.id)) {
          postedIds.push(deal.id);
          syncedIds = true;
        }
        continue;
      }

      candidates.push({ key: blob.key, deal });
    } catch (e) {
      console.error(`[FB] Error reading blob "${blob.key}":`, e.message);
    }
  }

  // Persist any IDs synced from deal flags during the scan
  if (syncedIds) {
    try { await savePostedIds(fbPostedStore, postedIds); } catch (_) {}
  }

  console.log(`[FB] Candidates for posting: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("[FB] Nothing to post â exiting");
    return { posted: 0, message: "No unposted deals" };
  }

  // Sort newest first. Post ONE deal per run â eliminates overlapping-run races.
  candidates.sort((a, b) => new Date(b.deal.createdAt) - new Date(a.deal.createdAt));
  const { key, deal } = candidates[0];

  console.log(
    `[FB] â¶ Posting: deal_id=${deal.id} source=${deal.source || "unknown"} ` +
    `title="${deal.title?.slice(0, 60)}" image="${(deal.image || deal.imageUrl || "none").slice(0, 60)}" ` +
    `createdAt=${deal.createdAt}`
  );

  try {
    const result = await callFacebookApi(deal);
    const ts = new Date().toISOString();

    // Write dedup store FIRST â even if deal blob write fails, we won't re-post.
    postedIds.push(deal.id);
    try {
      await savePostedIds(fbPostedStore, postedIds);
      console.log(`[FB] â deal_id=${deal.id} marked in facebook-posted store`);
    } catch (storeErr) {
      console.error(
        `[FB] â ï¸ CRITICAL: facebook-posted store write failed: ${storeErr.message}. ` +
        `Deal ${deal.id} was posted but dedup state not saved â will rely on deal blob flag.`
      );
    }

    // Update the deal blob.
    deal.postedToFacebook = true;
    deal.facebookPostId = result.id;
    deal.facebookPostedAt = ts;
    deal.postedAt = ts;
    deal.facebookFailCount = 0;
    try {
      await submissionsStore.set(key, JSON.stringify(deal));
      console.log(`[FB] â deal blob updated postedToFacebook=true facebookPostedAt=${ts}`);
    } catch (writeErr) {
      console.error(`[FB] â ï¸ Deal blob write failed (deal is safe in posted store):`, writeErr.message);
    }

    console.log(
      `[FB] â SUCCESS: deal_id=${deal.id} fb_post_id=${result.id} ` +
      `type=${result.type} title="${deal.title?.slice(0, 60)}" source=${deal.source} ts=${ts}`
    );
    return { posted: 1, dealId: deal.id, title: deal.title?.slice(0, 80), source: deal.source, fbPostId: result.id, type: result.type, timestamp: ts };

  } catch (err) {
    console.error(`[FB] â Post failed for deal_id=${deal.id}: ${err.message}`);

    deal.facebookFailCount = (deal.facebookFailCount || 0) + 1;
    deal.facebookLastError = err.message;
    deal.facebookLastErrorAt = new Date().toISOString();
    if (deal.facebookFailCount >= MAX_FAIL_COUNT) {
      deal.facebookPostFailed = true;
      console.error(
        `[FB] â deal_id=${deal.id} has failed ${deal.facebookFailCount} times â ` +
        `marking permanently skipped (facebookPostFailed=true)`
      );
    }

    try { await submissionsStore.set(key, JSON.stringify(deal)); } catch (_) {}
    return { posted: 0, error: err.message, dealId: deal.id, failCount: deal.facebookFailCount };
  }
}

// ââ Force-post a specific deal by ID âââââââââââââââââââââââââââââââââââââââââ
async function forcePostDeal(dealId) {
  const submissionsStore = getStore("submissions");
  const fbPostedStore = getStore("facebook-posted");

  const raw = await submissionsStore.get(dealId);
  if (!raw) throw new Error(`Deal not found: ${dealId}`);
  const deal = JSON.parse(raw);

  console.log(`[FB] Force-posting deal_id=${dealId} title="${deal.title?.slice(0, 60)}"`);
  const result = await callFacebookApi(deal);
  const ts = new Date().toISOString();

  const postedIds = await loadPostedIds(fbPostedStore);
  if (deal.id && !postedIds.includes(deal.id)) postedIds.push(deal.id);
  await savePostedIds(fbPostedStore, postedIds);

  deal.postedToFacebook = true;
  deal.facebookPostId = result.id;
  deal.facebookPostedAt = ts;
  deal.postedAt = ts;
  await submissionsStore.set(dealId, JSON.stringify(deal));

  console.log(`[FB] â Force-posted deal_id=${dealId} fb_post_id=${result.id}`);
  return result;
}

// ââ Handler âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default async function handler(req) {
  const url = new URL(req.url);
  const password = url.searchParams.get("password");
  const isScheduledRun = !url.searchParams.has("password");

  if (!isScheduledRun && password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`[FB] Triggered (${isScheduledRun ? "scheduled" : "manual"})`);
  console.log(`[FB] Env: FB_PAGE_TOKEN=${FB_PAGE_TOKEN ? "SET" : "MISSING"} FB_PAGE_ID=${FB_PAGE_ID ? "SET" : "MISSING"}`);

  try {
    if (req.method === "POST" && !isScheduledRun) {
      const body = await req.json().catch(() => ({}));
      if (body.dealId) {
        const result = await forcePostDeal(body.dealId);
        return new Response(JSON.stringify({ success: true, posted: 1, ...result }), {
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    const result = await postNextDeal();
    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[FB] Unhandled error:", err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
}

// ââ Schedule: run every 15 minutes âââââââââââââââââââââââââââââââââââââââââââ
export const config = {
  schedule: "*/15 * * * *",
};
