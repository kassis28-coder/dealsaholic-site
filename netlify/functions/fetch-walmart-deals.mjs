import { getStore } from "@netlify/blobs";

const ACCOUNT_SID = process.env.IMPACT_ACCOUNT_SID;
const AUTH_TOKEN = process.env.IMPACT_AUTH_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const AFFILIATE_PARAM = "wmlspartner=iplc1788825";
const MIN_DISCOUNT = 10;
const MAX_AGE_HOURS = 48;
const BLOCKED_WORDS = ["adult", "sex", "xxx", "erotic", "tobacco", "vape", "cbd"];

const SEARCH_TERMS = [
  "rollback",
  "clearance",
  "special buy",
  "electronics deal",
  "kitchen appliances",
  "toys sale",
  "clothing clearance",
  "home goods deal",
  "beauty deals",
  "fitness equipment",
];

function addAffiliateTag(url) {
  if (!url) return url;
  if (url.includes("wmlspartner=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}${AFFILIATE_PARAM}`;
}

function isBlocked(title = "") {
  const lower = title.toLowerCase();
  return BLOCKED_WORDS.some((w) => lower.includes(w));
}

function calcDiscount(price, originalPrice) {
  if (!price || !originalPrice || originalPrice <= price) return null;
  return Math.round(((originalPrice - price) / originalPrice) * 100);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getImpactAuth() {
  return Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64");
}

async function discoverCatalogs(auth) {
  const res = await fetch(
    `https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Catalogs?PageSize=50`,
    { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } }
  );
  if (!res.ok) { console.log(`Catalogs list failed: ${res.status}`); return []; }
  const data = await res.json();
  const catalogs = data?.Catalogs || data?.catalogs || [];
  console.log(`Found ${catalogs.length} catalog(s):`, catalogs.map((c) => `${c.Id} - ${c.Name}`).join(", "));
  return catalogs;
}

async function fetchCatalogItems(auth, catalogId, searchTerm) {
  const params = new URLSearchParams({ PageSize: "100", SearchTerm: searchTerm });
  const res = await fetch(
    `https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Catalogs/${catalogId}/Items?${params}`,
    { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return data?.Items || data?.items || [];
}

function normalizeImpactItem(raw) {
  const id = raw.Id || raw.CatalogItemId || raw.ItemId;
  const title = raw.Name || raw.Title || raw.Description;
  if (!id || !title || isBlocked(title)) return null;
  const price = parseFloat(raw.CurrentPrice || raw.SalePrice || raw.Price || 0);
  const originalPrice = parseFloat(raw.OriginalPrice || raw.WasPrice || raw.RegularPrice || 0);
  if (!price || price <= 0) return null;
  const discountPercent = calcDiscount(price, originalPrice);
  if (discountPercent !== null && discountPercent < MIN_DISCOUNT) return null;
  const image = raw.ImageUrl || raw.ThumbnailUrl || raw.Image || null;
  const rawUrl = raw.DirectLink || raw.TrackingLink || raw.Url || raw.Link;
  return {
    id: `walmart-${id}`, title,
    price: `$${price.toFixed(2)}`,
    originalPrice: originalPrice > 0 ? `$${originalPrice.toFixed(2)}` : null,
    discountPercent,
    url: addAffiliateTag(rawUrl || `https://www.walmart.com/ip/${id}`),
    image, store: "walmart", status: "approved", sponsored: false, source: "impact-catalog",
    createdAt: new Date().toISOString(),
    expiresOn: new Date(Date.now() + MAX_AGE_HOURS * 60 * 60 * 1000).toISOString(),
  };
}

async function fetchViaImpactCatalogs() {
  if (!ACCOUNT_SID || !AUTH_TOKEN) { console.log("Missing Impact credentials"); return []; }
  const auth = await getImpactAuth();
  const catalogs = await discoverCatalogs(auth);
  if (!catalogs.length) return [];
  const walmartCatalogs = catalogs.filter((c) => (c.Name || "").toLowerCase().includes("walmart"));
  if (!walmartCatalogs.length) {
  console.log("No Walmart-named catalog available in this Impact account; skipping to web scrape.");
  return [];
}
const targetCatalogs = walmartCatalogs;
  const seen = new Set(); const deals = [];
  for (const catalog of targetCatalogs) {
    for (const term of SEARCH_TERMS) {
      const items = await fetchCatalogItems(auth, catalog.Id, term);
      for (const raw of items) {
        const deal = normalizeImpactItem(raw);
        if (!deal || seen.has(deal.id)) continue;
        seen.add(deal.id);
        deals.push(deal);
      }
      await sleep(500);
    }
  }
  console.log(`Impact strategy: ${deals.length} deals found.`);
  return deals;
}

async function fetchWalmartPage(query) {
  const url = `https://www.walmart.com/search?q=${encodeURIComponent(query)}&sort=best_match`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "text/html",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) { console.log(`Walmart fetch failed: ${res.status}`); return []; }
console.log(`Walmart fetch ok: status=${res.status} finalUrl=${res.url}`);
  const html = await res.text();
  console.log(`Walmart HTML length: ${html.length}, hasNextData: ${html.includes("__NEXT_DATA__")}`);
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return [];
  // (diag) note: above line returns early if no NEXT_DATA match
  let pageData; try { pageData = JSON.parse(match[1]); } catch { return []; }
  const sr = pageData?.props?.pageProps?.initialData?.searchResult || pageData?.props?.pageProps?.searchResult || null;
  console.log(`Walmart parsed: hasSearchResult=${!!sr}, stacks=${(sr?.itemStacks||[]).length}, items=${(sr?.itemStacks||[]).reduce((n,s)=>n+(s.items?.length||0),0)}`);
  return (sr?.itemStacks || []).flatMap((s) => s.items || []);
}

function normalizeWalmartItem(raw) {
  const id = raw.usItemId || raw.itemId || raw.id;
  const title = raw.name || raw.title;
  if (!id || !title || isBlocked(title)) return null;
  const price = parseFloat(raw.priceInfo?.currentPrice?.price || 0);
  const originalPrice = parseFloat(raw.priceInfo?.wasPrice?.price || raw.priceInfo?.listPrice?.price || 0);
  if (!price || price <= 0) return null;
  const discountPercent = calcDiscount(price, originalPrice);
  const isRollback = (title || "").toLowerCase().includes("rollback");
  if (discountPercent !== null && discountPercent < MIN_DISCOUNT && !isRollback) return null;
  const canonicalUrl = raw.canonicalUrl ? `https://www.walmart.com${raw.canonicalUrl}` : `https://www.walmart.com/ip/${id}`;
  return {
    id: `walmart-${id}`, title,
    price: `$${price.toFixed(2)}`,
    originalPrice: originalPrice > 0 ? `$${originalPrice.toFixed(2)}` : null,
    discountPercent, url: addAffiliateTag(canonicalUrl),
    image: raw.imageInfo?.thumbnailUrl || null,
    store: "walmart", status: "approved", sponsored: false, source: "walmart-web",
    createdAt: new Date().toISOString(),
    expiresOn: new Date(Date.now() + MAX_AGE_HOURS * 60 * 60 * 1000).toISOString(),
  };
}

const WEB_QUERIES = ["rollback", "clearance", "special buy", "deal of the day"];

async function fetchViaWalmartWeb() {
  const seen = new Set(); const deals = [];
  for (const query of WEB_QUERIES) {
    const rawItems = await fetchWalmartPage(query);
    for (const raw of rawItems) {
      const deal = normalizeWalmartItem(raw);
      if (!deal || seen.has(deal.id)) continue;
      seen.add(deal.id);
      deals.push(deal);
    }
    await sleep(1500);
  }
  console.log(`Web scrape: ${deals.length} deals found.`);
  return deals;
}

async function saveDeals(deals) {
  const store = getStore("submissions");
  const { blobs } = await store.list();
  const existingKeys = new Set(blobs.map((b) => b.key));
  const now = Date.now();
  let index = [];
  try {
    const idxData = await store.get("index", { type: "json" });
    if (Array.isArray(idxData)) index = idxData;
  } catch {}
  for (const blob of blobs) {
    if (!blob.key.startsWith("walmart-")) continue;
    try {
      const raw = await store.get(blob.key);
      if (!raw) continue;
      const deal = JSON.parse(raw);
      if (deal.expiresOn && new Date(deal.expiresOn).getTime() < now) {
        await store.delete(blob.key);
        existingKeys.delete(blob.key);
        index = index.filter((i) => i !== blob.key);
      }
    } catch {}
  }
  let added = 0;
  for (const deal of deals) {
    if (existingKeys.has(deal.id)) continue;
    await store.set(deal.id, JSON.stringify(deal));
    if (!index.includes(deal.id)) index.unshift(deal.id);
    added++;
  }
  await store.setJSON("index", index);
await store.setJSON("index", index);
await store.setJSON("index", index);
return { added, total: deals.length };
}

async function run() {
  let deals = await fetchViaImpactCatalogs();
  if (deals.length === 0) { console.log("Impact returned 0. Trying web..."); deals = await fetchViaWalmartWeb(); }
  if (deals.length === 0) return { success: true, added: 0, total: 0, note: "No deals found" };
  const result = await saveDeals(deals);
  return { success: true, ...result };
}

export default async function handler(req) {
  if (req && req.method === "GET") {
    const url = new URL(req.url);
    const password = url.searchParams.get("password");
    if (!password || password !== ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    try {
      const result = await run();
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500, headers: { "Content-Type": "application/json" },
      });
    }
  }
  try { await run(); } catch (err) { console.error("Scheduled error:", err.message); }
}

export const config = {};
