// backfill-deal-images.mjs
// One-time endpoint: loops all submissions, downloads missing images, updates records.
// GET /api/backfill-deal-images?password=YOUR_ADMIN_PASSWORD
// GET /api/backfill-deal-images?password=...&dry=1   <- dry run (no writes)
// GET /api/backfill-deal-images?password=...&limit=20 <- process at most N deals

import { getStore } from "@netlify/blobs";

const HOSTED_PREFIX = "https://deals-aholic.com/api/deal-image?id=";

function extractAsinFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/(dp|gp\/product)\/([A-Z0-9]{10})/i);
  return m ? m[2] : null;
}

// Fetch the page and scan HTML for ASIN — works for promocode URLs and short links
async function resolveAsinViaRedirect(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });

    const asinFromUrl = extractAsinFromUrl(res.url);
    if (asinFromUrl) return asinFromUrl;

    const html = await res.text();

    const dataAsin = html.match(/data-asin=["']([A-Z0-9]{10})["']/i);
    if (dataAsin?.[1]) return dataAsin[1];

    const scriptAsin = html.match(/"asin"\s*:\s*["']([A-Z0-9]{10})["']/i)
                    || html.match(/["']ASIN["']\s*:\s*["']([A-Z0-9]{10})["']/i);
    if (scriptAsin?.[1]) return scriptAsin[1];

    const urlAsin = html.match(/\/(dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (urlAsin?.[2]) return urlAsin[2];

    return null;
  } catch (e) {
    console.log(`[backfill] resolveAsinViaRedirect(${url}) failed: ${e.message}`);
    return null;
  }
}

async function fetchAmazonProductImage(asin) {
  if (!asin) return null;
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith("http")) return ogMatch[1];

    const cdnPattern = /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
    for (const img of (html.match(cdnPattern) || [])) {
      const clean = img.split("?")[0];
      if (!/_SL75_|_SS40_|_AC_US\d+_|thumbnail/i.test(clean)) return clean;
    }
    return null;
  } catch (e) {
    console.log(`[backfill] fetchAmazonProductImage(${asin}) failed: ${e.message}`);
    return null;
  }
}

// Fetch image directly from a product URL (fallback when no ASIN available)
async function fetchImageFromUrl(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith("http")) return ogMatch[1];

    const cdnPattern = /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
    for (const img of (html.match(cdnPattern) || [])) {
      const clean = img.split("?")[0];
      if (!/_SL75_|_SS40_|_AC_US\d+_|thumbnail/i.test(clean)) return clean;
    }
    return null;
  } catch (e) {
    console.log(`[backfill] fetchImageFromUrl(${url}) failed: ${e.message}`);
    return null;
  }
}

async function downloadAndStoreImage(key, imageUrl) {
  if (!key || !imageUrl) return null;
  try {
    const imageStore = getStore("deal-images");
    const existing = await imageStore.getMetadata(key).catch(() => null);
    if (existing) return `${HOSTED_PREFIX}${key}`;

    const imgRes = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!imgRes.ok) return null;

    const buffer = await imgRes.arrayBuffer();
    if (buffer.byteLength < 1000) return null;

    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    await imageStore.set(key, buffer, { metadata: { contentType } });
    return `${HOSTED_PREFIX}${key}`;
  } catch (e) {
    console.warn(`[backfill] downloadAndStoreImage(${key}) failed: ${e.message}`);
    return null;
  }
}

export default async (req) => {
  const url = new URL(req.url);
  const password = url.searchParams.get("password");
  const dry = url.searchParams.get("dry") === "1";
  const limit = parseInt(url.searchParams.get("limit") || "0", 10);

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword || password !== adminPassword) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const store = getStore("submissions");
    const index = await store.get("index", { type: "json" }).catch(() => []) || [];

    const results = { total: index.length, processed: 0, updated: 0, skipped: 0, failed: 0, log: [] };
    const toProcess = limit > 0 ? index.slice(0, limit) : index;

    for (const id of toProcess) {
      results.processed++;
      let record;
      try {
        record = await store.get(id, { type: "json" });
      } catch {
        results.log.push({ id, status: "skip", reason: "could not read record" });
        results.skipped++;
        continue;
      }

      if (!record) { results.skipped++; continue; }
      if (record.imageUrl?.startsWith(HOSTED_PREFIX)) { results.skipped++; continue; }

      // Try all possible URL field names
      const productUrl = record.url || record.amazonUrl || record.link || null;

      // Try all possible ways to get ASIN
      let asin = record.asin
        || extractAsinFromUrl(record.url)
        || extractAsinFromUrl(record.amazonUrl)
        || extractAsinFromUrl(record.link);

      if (!asin && productUrl) {
        asin = await resolveAsinViaRedirect(productUrl);
      }

      // If still no ASIN and no URL, skip
      if (!asin && !productUrl) {
        results.log.push({ id, title: record.title, status: "skip", reason: "no ASIN and no URL" });
        results.skipped++;
        continue;
      }

      // Get image — via ASIN first, then directly from URL
      let imageUrl = record.imageUrl;
      if (!imageUrl) {
        if (asin) {
          imageUrl = await fetchAmazonProductImage(asin);
        }
        if (!imageUrl && productUrl) {
          imageUrl = await fetchImageFromUrl(productUrl);
        }
      }

      if (!imageUrl) {
        results.log.push({ id, title: record.title, asin, status: "fail", reason: "no image found" });
        results.failed++;
        continue;
      }

      // Use ASIN as store key if available, otherwise use record id
      const storeKey = asin || id;
      const hostedUrl = await downloadAndStoreImage(storeKey, imageUrl);
      if (!hostedUrl) {
        results.log.push({ id, title: record.title, asin, status: "fail", reason: "download failed" });
        results.failed++;
        continue;
      }

      if (!dry) {
        record.imageUrl = hostedUrl;
        if (asin) record.asin = asin;
        await store.setJSON(id, record);
      }

      results.log.push({ id, title: record.title, asin, status: dry ? "dry-run" : "updated", imageUrl: hostedUrl });
      results.updated++;
    }

    return new Response(JSON.stringify({ dry, ...results }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config = { path: "/api/backfill-deal-images" };
