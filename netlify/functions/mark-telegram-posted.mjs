// mark-telegram-posted.mjs
// One-time fix: marks all deals that already have facebookPosted=true
// as telegramPosted=true so the new Telegram function doesn't re-post them.
// Call via: GET /api/mark-telegram-posted?password=YOUR_ADMIN_PASSWORD
// Add dry=1 to preview without making changes.

import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const password = url.searchParams.get("password");
  const dryRun = url.searchParams.get("dry") === "1";

  if (password !== process.env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { "Content-Type": "application/json" },
    });
  }

  const store = getStore("submissions");

  let index = [];
  try { index = (await store.get("index", { type: "json" })) || []; } catch { index = []; }

  let marked = 0;
  let skipped = 0;
  let errors = 0;
  const preview = [];

  for (const id of index) {
    let deal = null;
    try { deal = await store.get(id, { type: "json" }); } catch { errors++; continue; }
    if (!deal) { errors++; continue; }

    // Already marked — skip
    if (deal.telegramPosted === true) { skipped++; continue; }

    // Mark as telegramPosted if facebookPosted=true (old system posted it)
    // OR if it's older than 1 hour (assume it was already handled by old system)
    const isOld = deal.createdAt && (Date.now() - new Date(deal.createdAt).getTime()) > 60 * 60 * 1000;
    const wasPostedByOldSystem = deal.facebookPosted === true || isOld;

    if (wasPostedByOldSystem) {
      preview.push({ id, title: deal.title, facebookPosted: deal.facebookPosted, createdAt: deal.createdAt });
      if (!dryRun) {
        try {
          await store.setJSON(id, { ...deal, telegramPosted: true, telegramPostedAt: deal.facebookPostedAt || deal.createdAt || new Date().toISOString() });
          marked++;
        } catch { errors++; }
      } else {
        marked++;
      }
    } else {
      skipped++;
    }
  }

  return new Response(JSON.stringify({
    success: true,
    dry_run: dryRun,
    total_deals: index.length,
    marked,
    skipped,
    errors,
    preview: dryRun ? preview : undefined,
  }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
};
