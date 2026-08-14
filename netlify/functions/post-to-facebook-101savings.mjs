import { getStore } from "@netlify/blobs";

// Separate Page credentials for "101 Savings" — does not touch or share
// any state with post-to-facebook.mjs (the existing deals-aholic Page function).
const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN_101SAVINGS;
const FB_PAGE_ID = process.env.FB_PAGE_ID_101SAVINGS;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const FB_REQUEST_TIMEOUT_MS = 12_000;

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
