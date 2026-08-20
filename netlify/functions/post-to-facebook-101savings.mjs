import { getStore } from "@netlify/blobs";

// Separate Page credentials for "101 Savings" — does not touch or share
// any state with post-to-facebook.mjs (the existing deals-aholic Page function).
const FB_PAGE_TOKEN =
  process.env.FB_PAGE_TOKEN_101SAVINGS ||
  process.env.FACEBOOK_101SAVINGS_PAGE_TOKEN;
const FB_PAGE_ID =
  process.env.FB_PAGE_ID_101SAVINGS ||
  process.env.FACEBOOK_101SAVINGS_PAGE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const FB_REQUEST_TIMEOUT_MS = 12_000;
const LOCK_STALE_MS = 30 * 60 * 1000;

async function getJoyLinkUrl(amazonUrl, asin) {
  const apiKey = process.env.JOYLINK_API_KEY;
  if (!apiKey || !amazonUrl) return null;

  const cache = getStore("joylink-cache");
  const trackingId = process.env.AMAZON_PARTNER_TAG || "daholic-20";
  const cacheKey = `${trackingId}:${asin || amazonUrl}`;

  try {
    const cached = await cache.get(cacheKey, { type: "json" });
    if (cached?.url) return cached.url;
  } catch {}

  try {
    const res = await fetch("https://api.joylink.io/public/createlink", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ destination: amazonUrl, trackingid: trackingId }),
    });
    const data = await res.json();
    if (res.ok && data.url) {
      await cache.setJSON(cacheKey, { url: data.url, createdAt: new Date().toISOString() }).catch(() => {});
      return data.url;
    }
    console.error("[101-savings] JoyLink API error:", JSON.stringify(data));
  } catch (err) {
    console.error("[101-savings] JoyLink request failed:", err.message);
  }

  return null;
}

async function postDealToFacebook(deal) {
  if (!FB_PAGE_TOKEN || !FB_PAGE_ID) {
    throw new Error("Missing FB_PAGE_TOKEN_101SAVINGS or FB_PAGE_ID_101SAVINGS env vars");
  }

  const caption = buildCaption(deal);

  if (deal.image) {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/photos`,
      {
        method: "POST",
        signal: AbortSignal.timeout(FB_REQUEST_TIMEOUT_MS),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: deal.image,
          caption,
          access_token: FB_PAGE_TOKEN,
        }),
      }
    );
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || "FB photo post failed");
    return { type: "photo", id: data.id, post_id: data.post_id };
  }

  const res = await fetch(
    `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/feed`,
    {
      method: "POST",
      signal: AbortSignal.timeout(FB_REQUEST_TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: caption,
        link: deal.url,
        access_token: FB_PAGE_TOKEN,
      }),
    }
  );
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || "FB feed post failed");
  return { type: "feed", id: data.id };
}

async function isAlreadyPostedOn101Savings(deal) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/posts?fields=message&limit=100&access_token=${FB_PAGE_TOKEN}`,
      { signal: AbortSignal.timeout(FB_REQUEST_TIMEOUT_MS) }
    );
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.data)) return false;

    const title = String(deal.title || "").trim().toLowerCase();
    const url = String(deal.url || "").trim().toLowerCase();
    return data.data.some((post) => {
      const message = String(post.message || "").toLowerCase();
      return (url && message.includes(url)) || (title && message.includes(title));
    });
  } catch (err) {
    console.warn("[101-savings] Live duplicate check failed:", err.message);
    return false;
  }
}

function buildCaption(deal) {
  const lines = [];
  lines.push(`🔥 New Deal Alert!`);
  lines.push(``);
  lines.push(deal.title);
  if (deal.price) {
    lines.push(``);
    lines.push(
      deal.originalPrice && deal.discountPercent
        ? `💰 ${deal.price} (was ${deal.originalPrice} — ${deal.discountPercent}% off!)`
        : `💰 ${deal.price}`
    );
  }
  lines.push(``);
  lines.push(`🛒 Shop now: ${deal.url}`);
  lines.push(``);
  lines.push(`#ad #deals #101savings #sale #shopping`);
  return lines.join("\n");
}

function siteDealKey(deal) {
  return String(deal.asin || deal.id || deal.url || deal.title || "");
}

export async function postSiteDealsTo101Savings(limit = 1) {
  const dealsStore = getStore("deals");
  const stateStore = getStore("amazon-101-savings-posts");
  const data = await dealsStore.get("latest", { type: "json" }).catch(() => null);
  const deals = Array.isArray(data?.deals) ? data.deals : [];

  if (deals.length === 0) return { posted: 0, results: [] };

  const lock = await stateStore.get("posting-lock", { type: "json" }).catch(() => null);
  if (
    lock?.startedAt &&
    Date.now() - new Date(lock.startedAt).getTime() < LOCK_STALE_MS
  ) {
    return { posted: 0, results: [], message: "Posting already running" };
  }

  await stateStore.setJSON("posting-lock", { startedAt: new Date().toISOString() });

  try {
    const postedKeys = await stateStore.get("posted", { type: "json" }).catch(() => []);
    const posted = Array.isArray(postedKeys) ? postedKeys : [];
    const results = [];

    for (const deal of deals) {
      if (results.length >= limit) break;
      if (
        deal.needsReview ||
        !deal.title ||
        !deal.url ||
        !deal.image ||
        Number(deal.discountPercent) < 20
      ) {
        continue;
      }

      const key = siteDealKey(deal);
      if (!key || posted.includes(key)) continue;

      if (await isAlreadyPostedOn101Savings(deal)) {
        posted.push(key);
        results.push({ title: deal.title.slice(0, 50), duplicateSkipped: true });
        continue;
      }

      const joyLinkUrl = await getJoyLinkUrl(deal.url, deal.asin || null);
      const result = await postDealToFacebook({ ...deal, url: joyLinkUrl || deal.url });
      posted.push(key);
      results.push({ title: deal.title.slice(0, 50), ...result });
    }

    await stateStore.setJSON("posted", posted);
    return { posted: results.filter(result => !result.duplicateSkipped).length, results };
  } finally {
    await stateStore.delete("posting-lock").catch(() => {});
  }
}

export async function postPendingDeals(limit = 5) {
  const store = getStore("submissions");
  const stateStore = getStore("automation-state");
  const results = [];
  let posted = 0;
  const scanLimit = 25;

  // The submissions index is already newest-first. Read it in parallel,
  // bounded batches and stop as soon as the requested number is posted. The
  // previous implementation read every Blob sequentially and timed out before
  // it ever reached Facebook.
  let keys = await store.get("index", { type: "json" }).catch(() => []);
  if (!Array.isArray(keys) || keys.length === 0) {
    const { blobs } = await store.list();
    keys = blobs.map(blob => blob.key).filter(key => key !== "index");
  }

  if (keys.length === 0) return { posted, results };

  // Resume where the previous run stopped. This prevents every scheduled run
  // from rescanning thousands of older records before reaching Facebook.
  const savedCursor = await stateStore.get("facebook-101-cursor", { type: "json" }).catch(() => null);
  const start = Number.isInteger(savedCursor?.position)
    ? savedCursor.position % keys.length
    : 0;
  const batchKeys = Array.from(
    { length: Math.min(scanLimit, keys.length) },
    (_, index) => keys[(start + index) % keys.length]
  );
  const records = await Promise.all(batchKeys.map(async key => ({
    key,
    deal: await store.get(key, { type: "json" }).catch(() => null),
  })));

  for (let index = 0; index < records.length && posted < limit; index += 1) {
    const { key, deal } = records[index];
    const nextPosition = (start + index + 1) % keys.length;
    if (!deal || deal.status !== "approved") continue;
      // Never publish incomplete/review-only deals. The scheduled Page feed is
      // intentionally image-first, matching the existing Facebook workflow.
    if (!deal.title || !deal.url || !deal.image) continue;
      // Independent posted-flag from the deals-aholic Page, so a deal can be
      // posted to one Page, both, or neither without the two functions
      // interfering with each other.
    if (deal.postedTo101Savings) continue;

    try {
      if (await isAlreadyPostedOn101Savings(deal)) {
        deal.postedTo101Savings = true;
        deal.duplicateSkipped101Savings = true;
        deal.postedAt101Savings = new Date().toISOString();
        await store.setJSON(key, deal);
        await stateStore.setJSON("facebook-101-cursor", { position: nextPosition });
        results.push({ title: deal.title.slice(0, 50), duplicateSkipped: true });
        return { posted, results };
      }

      const result = await postDealToFacebook(deal);
      deal.postedTo101Savings = true;
      deal.facebookPostId101Savings = result.id;
      deal.postedAt101Savings = new Date().toISOString();
      await store.setJSON(key, deal);
      await stateStore.setJSON("facebook-101-cursor", { position: nextPosition });
      results.push({ title: deal.title.slice(0, 50), ...result });
      posted += 1;
    } catch (err) {
      results.push({ title: deal.title?.slice(0, 50), error: err.message });
      await stateStore.setJSON("facebook-101-cursor", { position: nextPosition });
      return { posted, results };
    }
  }

  await stateStore.setJSON("facebook-101-cursor", {
    position: (start + records.length) % keys.length,
  });

  return {
    posted,
    results,
  };
}

export default async function handler(req) {
  const url = new URL(req.url);
  const password = url.searchParams.get("password");

  if (!password || password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    let result;

    if (req.method === "POST") {
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
        deal.postedTo101Savings = true;
        deal.facebookPostId101Savings = fbResult.id;
        deal.postedAt101Savings = new Date().toISOString();
        await store.set(body.dealId, JSON.stringify(deal));
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
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const config = {};
