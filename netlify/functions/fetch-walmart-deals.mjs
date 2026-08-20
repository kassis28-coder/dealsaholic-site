import { getStore } from "@netlify/blobs";

const ACCOUNT_SID = process.env.IMPACT_ACCOUNT_SID;
const AUTH_TOKEN = process.env.IMPACT_AUTH_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const WALMART_IMPACT_PREFIX = process.env.WALMART_IMPACT_PREFIX || "https://goto.walmart.com/c/1788825/1398372/16662?u=";
const MIN_DISCOUNT = 10;
const MAX_AGE_HOURS = 48;
const BLOCKED_WORDS = ["adult", "sex", "xxx", "erotic", "tobacco", "vape", "cbd"];

const CATALOG_PAGES = 3;

function addAffiliateTag(url) {
  if (!url) return url;
  if (/goto\.walmart\.com\/c\/1788825\//i.test(url)) return url;
  return `${WALMART_IMPACT_PREFIX}${encodeURIComponent(url)}`;
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

async function fetchCatalogItems(auth, catalogId, page) {
  // Use the catalog-specific endpoint. ItemSearch searches every available
  // catalog and does not document CatalogId as a supported parameter.
  const params = new URLSearchParams({ PageSize: "200", Page: String(page) });
  const res = await fetch(
    `https://api.impact.com/Mediapartners/${ACCOUNT_SID}/Catalogs/${catalogId}/Items?${params}`,
    { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } }
  );
  if (!res.ok) {
    console.log(`Walmart catalog ${catalogId}, page ${page} failed: ${res.status}`);
    return [];
  }
  const data = await res.json();
  if (Array.isArray(data)) return data;
  return data?.Items || data?.items || data?.CatalogItems || data?.catalogItems || [];
}

function normalizeImpactItem(raw) {
  const id = raw.Id || raw.CatalogItemId || raw.ItemId;
  const title = raw.Name || raw.Title || raw.Description;
  if (!id || !title || isBlocked(title)) return null;
  const price = parseFloat(raw.CurrentPrice || raw.SalePrice || raw.Price || 0);
  const originalPrice = parseFloat(raw.OriginalPrice || raw.WasPrice || raw.RegularPrice || 0);
  if (!price || price <= 0) return null;
  const calculatedDiscount = calcDiscount(price, originalPrice);
  const suppliedDiscount = parseFloat(raw.DiscountPercentage || 0);
  const discountPercent = calculatedDiscount ?? (suppliedDiscount > 0 ? Math.round(suppliedDiscount) : null);
  const hasPromotion = Array.isArray(raw.Promotions) && raw.Promotions.length > 0;
  if ((discountPercent === null || discountPercent < MIN_DISCOUNT) && !hasPromotion) return null;
  const image = raw.ImageUrl || raw.ThumbnailUrl || raw.Image || null;
  const rawUrl = raw.DirectLink || raw.TrackingLink || raw.Url || raw.URL || raw.MobileUrl || raw.Link;
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
    console.log("No Walmart-named catalog is available in this Impact account.");
    return [];
  }
  const seen = new Set(); const deals = [];
  for (const catalog of walmartCatalogs) {
    for (let page = 0; page < CATALOG_PAGES; page++) {
      const items = await fetchCatalogItems(auth, catalog.Id, page);
      for (const raw of items) {
        const deal = normalizeImpactItem(raw);
        if (!deal || seen.has(deal.id)) continue;
        seen.add(deal.id);
        deals.push(deal);
      }
      if (items.length < 200) break;
      await sleep(250);
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


// Walmart blocks automated product-search requests from cloud functions. Use the
// public Slickdeals RSS feed only as a fallback when both authorized Impact
// catalogs and Walmart's own page return zero items.
const SLICKDEALS_WALMART_RSS =
  "https://slickdeals.net/newsearch.php?q=walmart&searcharea=deals&searchin=first&rss=1";

function decodeXml(value = "") {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function xmlTag(xml, tag) {
  const match = xml.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\\/" + tag + ">", "i"));
  return match ? decodeXml(match[1]).trim() : "";
}

function cleanDealTitle(title) {
  return decodeXml(title).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function moneyFrom(value) {
  const match = String(value || "").match(/\$\s*(\d{1,5}(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function walmartUrlFromFeed(item, title) {
  const text = decodeXml(item).replace(/&amp;/g, "&");
  const direct = text.match(/https?:\/\/(?:www\.)?walmart\.com\/[^\s<"'\\]+/i)?.[0] || "";
  if (direct && !direct.includes("...")) return direct;
  return "https://www.walmart.com/search?q=" + encodeURIComponent(title);
}

function normalizeSlickdealsItem(item) {
  const title = cleanDealTitle(xmlTag(item, "title"));
  const guid = xmlTag(item, "guid").replace(/^thread-/, "");
  const description = decodeXml(xmlTag(item, "description"));
  const content = decodeXml(xmlTag(item, "content:encoded"));
  const combined = title + " " + description + " " + content;
  if (!title || !guid || !/walmart(?:\.com)?/i.test(combined) || isBlocked(title)) return null;

  const price = moneyFrom(title) || moneyFrom(description);
  if (!price || price <= 0) return null;

  const originalMatch = combined.match(/(?:reg(?:ular)?\.?|was|orig(?:inal)?(?: price)?)\s*[:$]?\s*\$?\s*(\d{1,5}(?:\.\d{1,2})?)/i);
  const originalPrice = originalMatch ? Number(originalMatch[1]) : null;
  const discountPercent = calcDiscount(price, originalPrice);
  const image = content.match(/<img[^>]+src=["']([^"']+)/i)?.[1] || null;
  const publishedAt = xmlTag(item, "pubDate");
  const createdAt = publishedAt && !Number.isNaN(Date.parse(publishedAt))
    ? new Date(publishedAt).toISOString()
    : new Date().toISOString();

  return {
    id: "walmart-sd-" + guid,
    title,
    price: "$" + price.toFixed(2),
    originalPrice: originalPrice ? "$" + originalPrice.toFixed(2) : null,
    discountPercent,
    url: addAffiliateTag(walmartUrlFromFeed(combined, title)),
    image,
    store: "walmart",
    status: "approved",
    sponsored: false,
    source: "slickdeals-walmart",
    createdAt,
    expiresOn: new Date(Date.now() + MAX_AGE_HOURS * 60 * 60 * 1000).toISOString(),
  };
}

async function fetchViaSlickdeals() {
  try {
    const res = await fetch(SLICKDEALS_WALMART_RSS, {
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml;q=0.9",
        "User-Agent": "DealsAholic/1.0",
      },
    });
    if (!res.ok) {
      console.log("Slickdeals Walmart RSS failed: " + res.status);
      return [];
    }
    const xml = await res.text();
    const seen = new Set();
    const deals = [];
    for (const item of xml.match(/<item>[\s\S]*?<\/item>/gi) || []) {
      const deal = normalizeSlickdealsItem(item);
      if (!deal || seen.has(deal.id)) continue;
      seen.add(deal.id);
      deals.push(deal);
    }
    console.log("Slickdeals Walmart fallback: " + deals.length + " deals found.");
    return deals;
  } catch (err) {
    console.log("Slickdeals Walmart RSS error: " + err.message);
    return [];
  }
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
  return { added, total: deals.length };
}

async function run() {
  let deals = await fetchViaImpactCatalogs();
  if (deals.length === 0) { console.log("Impact returned 0. Trying Walmart web..."); deals = await fetchViaWalmartWeb(); }
  if (deals.length === 0) { console.log("Walmart web returned 0. Trying RSS fallback..."); deals = await fetchViaSlickdeals(); }
  if (deals.length === 0) return { success: true, added: 0, total: 0, note: "No Walmart deals found from any configured source" };
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

export const config = { schedule: "15 * * * *" };
