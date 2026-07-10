import { getStore } from "@netlify/blobs";

// ── Env vars ─────────────────────────────────────────────────────────────────
// Support both naming conventions (FB_PAGE_TOKEN and FACEBOOK_PAGE_TOKEN) so
// whichever name is set in Netlify Dashboard works.
const FB_PAGE_TOKEN =
  process.env.FB_PAGE_TOKEN || process.env.FACEBOOK_PAGE_TOKEN;
const FB_PAGE_ID =
  process.env.FB_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Strip Amazon image modifier junk before posting to Facebook.
function cleanAmazonImageUrl(url) {
  if (!url) return url;
  const m = url.match(/(https:\/\/m\.media-amazon\.com\/images\/[A-Z]\/[A-Za-z0-9+%]+)/i);
  if (m) return m[1] + '._SL1500_.jpg';
  return url;
}

// ── Facebook API helper ───────────────────────────────────────────────────────
async function postDealToFacebook(deal) {
  if (!FB_PAGE_TOKEN || !FB_PAGE_ID) {
    throw new Error(
      "Missing Facebook env vars. Set FB_PAGE_TOKEN and FB_PAGE_ID in Netlify."
    );
  }

  const caption = buildCaption(deal);
  const imageUrl = cleanAmazonImageUrl(deal.image || deal.imageUrl || null);

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
    "🔥 New Deal Alert!",
    "",
    deal.title || "Amazing Deal",
  ];
  if (deal.price) {
    lines.push("");
    lines.push(
      deal.originalPrice && deal.discountPercent
        ? `💰 ${deal.price} (was ${deal.originalPrice} — ${deal.discountPercent}% off!)`
        : `💰 ${deal.price}`
    );
  }
  lines.push("");
  lines.push(`🛒 Shop now: ${deal.url}`);
  lines.push("");
  lines.push("#ad #deals #dealsaholic #sale #shopping");
  return lines.join("\n");
}

// ── Main posting logic ────────────────────────────────────────────────────────
async function postPendingDeals(limit = 5) {
  const store = getStore("submissions");
  const { blobs } = await store.list();
  console.log(`[FB] Total blobs in submissions: ${blobs.length}`);

  const deals = [];
  for (const blob of blobs) {
    if (blob.key === "index") continue; // skip index blob
    try {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      const deal = JSON.parse(raw);
      if (deal.status !== "approved") continue;
      if (deal.postedToFacebook) continue;
      deals.push({ key: blob.key, deal });
    } catch (e) {
      console.error(`[FB] Failed to read blob "${blob.key}":`, e.message);
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
      deal.postedToFacebook = true;
      deal.facebookPostId = result.id;
      deal.postedAt = new Date().toISOString();
      await store.set(key, JSON.stringify(deal));
      console.log(`[FB] ✅ Posted successfully: type=${result.type} id=${result.id}`);
      results.push({ title: deal.title?.slice(0, 50), ...result });
    } catch (err) {
      console.error(`[FB] ❌ Failed to post deal "${deal.title?.slice(0, 50)}":`, err.message);
      results.push({ title: deal.title?.slice(0, 50), error: err.message });
    }
  }

  return { posted: results.filter((r) => !r.error).length, results };
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  const url = new URL(req.url);
  const password = url.searchParams.get("password");

  // Scheduled invocations have no query params — allow them through.
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
    `[FB] Env check — FB_PAGE_TOKEN=${FB_PAGE_TOKEN ? "SET" : "MISSING"} FB_PAGE_ID=${FB_PAGE_ID ? "SET" : "MISSING"}`
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
        deal.postedAt = new Date().toISOString();
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
    console.error("[FB] Unhandled error:", err.message, err.stack);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Schedule: run every 15 minutes ───────────────────────────────────────────
// BUG FIX: was `export const config = {}` — no schedule, so Facebook NEVER
// ran automatically. Adding schedule here fixes automatic posting.
export const config = {
  schedule: "*/15 * * * *",
};
