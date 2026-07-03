import { getStore } from "@netlify/blobs";

const FB_PAGE_TOKEN = process.env.FB_PAGE_TOKEN;
const FB_PAGE_ID = process.env.FB_PAGE_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

async function postDealToFacebook(deal) {
  if (!FB_PAGE_TOKEN || !FB_PAGE_ID) {
    throw new Error("Missing FB_PAGE_TOKEN or FB_PAGE_ID env vars");
  }

  const caption = buildCaption(deal);

  if (deal.image) {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${FB_PAGE_ID}/photos`,
      {
        method: "POST",
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
  lines.push(`#deals #dealsaholic #sale #shopping`);
  return lines.join("\n");
}

async function postPendingDeals(limit = 5) {
  const store = getStore("submissions");
  const { blobs } = await store.list();

  const deals = [];
  for (const blob of blobs) {
    try {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      const deal = JSON.parse(raw);
      if (deal.status !== "approved") continue;
      if (deal.postedToFacebook) continue;
      deals.push({ key: blob.key, deal });
    } catch {}
  }

  deals.sort((a, b) =>
    new Date(b.deal.createdAt) - new Date(a.deal.createdAt)
  );

  const toPost = deals.slice(0, limit);
  const results = [];

  for (const { key, deal } of toPost) {
    try {
      const result = await postDealToFacebook(deal);
      deal.postedToFacebook = true;
      deal.facebookPostId = result.id;
      deal.postedAt = new Date().toISOString();
      await store.set(key, JSON.stringify(deal));
      results.push({ title: deal.title.slice(0, 50), ...result });
    } catch (err) {
      results.push({ title: deal.title?.slice(0, 50), error: err.message });
    }
  }

  return { posted: results.length, results };
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
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export const config = { schedule: "0 */6 * * *" };
