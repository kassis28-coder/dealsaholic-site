import { getStore } from "@netlify/blobs";

// Rebuilding this feed requires reading more than 2,000 reviewed submissions.
// Keep the already-built feed warm long enough that normal visitors never pay
// that cold-build cost. New Amazon and Walmart results become visible within a few minutes.
const PUBLIC_FEED_CACHE_TTL_MS = 5 * 60 * 1000;
// Bump this whenever the rules that decide whether an approved deal is public
// change, so the first request after deployment rebuilds instead of serving
// the old decision from a durable cache.
const PUBLIC_FEED_CACHE_KEY = "latest-deduped-v5";

// Keep Amazon search inventory fresh; seller deals still use their own expiry dates.
const AMAZON_PUBLIC_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PUBLIC_AMAZON_DEALS = 250;

// The homepage only renders a handful of cards. Sending the complete public
// catalog (currently thousands of seller submissions) delays first paint on
// slower connections, so serve a compact, purpose-built payload there.
const HOME_STORE_DEALS_PER_STORE = 35;
const HOME_PROMO_DEALS = 35;

const RESPONSE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=30",
  "Netlify-CDN-Cache-Control":
    "public, durable, max-age=300, stale-while-revalidate=1800",
};

const STALE_RESPONSE_HEADERS = {
  ...RESPONSE_HEADERS,
  "Netlify-CDN-Cache-Control":
    "public, durable, max-age=60, stale-while-revalidate=1800",
};

// Titles that come from email auto-replies, bounces, or failed parsing.
const GARBAGE_TITLE_RE =
  /^(?:the response was|message not delivered|undelivered mail|auto.?reply|delivery status|mail delivery|failure notice|returned mail|amazon deal|no title|untitled)\b/i;

const GENERIC_DEAL_TITLES = new Set([
  "with deal",
  "price drop",
  "at checkout",
  "amazon deal",
  "limited time deal",
]);

const COMMON_COLORS_RE =
  /\b(?:black|white|gray|grey|red|blue|green|yellow|orange|purple|pink|brown|beige|tan|navy|teal|gold|silver|rose gold|multicolor|multi color|assorted|clear)\b/g;

const COMMON_SIZE_WORDS_RE =
  /\b(?:xxs|xs|small|medium|large|xl|xxl|xxxl|extra small|extra large|one size|os|twin|twin xl|full|queen|king|cal king|california king|standard|mini|compact|regular|short|long|wide|narrow)\b/g;

function normalizeAsin(value) {
  const asin = String(value || "").trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(asin) ? asin : "";
}

function normalizeAmazonUrl(value) {
  if (!value) return "";

  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");

    if (!/(^|\.)amazon\.com$/.test(host)) return "";

    const asin =
      url.pathname.match(
        /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i
      )?.[1];

    if (asin) {
      return `amazon.com/dp/${asin.toUpperCase()}`;
    }

    const path = url.pathname
      .replace(/\/+$/, "")
      .toLowerCase();

    return path ? `${host}${path}` : "";

  } catch {
    return "";
  }
}

async function getReportedAmazonDeals() {
  const ids = new Set();
  const urls = new Set();

  try {
    const store = getStore("flagged-deals");

    const listing = await store
      .list()
      .catch(() => ({ blobs: [] }));

    const records = await Promise.all(
      (listing.blobs || []).map(blob =>
        store
          .get(blob.key, { type: "json" })
          .catch(() => null)
      )
    );

    for (const record of records) {
      if (!record) continue;

      const id = normalizeAsin(
        record.asin || record.dealId
      );

      if (id) {
        ids.add(id);
      }

      const url = normalizeAmazonUrl(
        record.productUrl || record.url
      );

      if (url) {
        urls.add(url);
      }
    }

  } catch (err) {
    console.log(
      "Could not load flagged Amazon deals:",
      err.message
    );
  }

  return { ids, urls };
}

function normalizeImage(value) {
  if (!value) return "";

  try {
    const url = new URL(value);
    const host =
      url.hostname.toLowerCase().replace(/^www\./, "");

    const path = decodeURIComponent(url.pathname)
      .replace(/\._[^/]+_(?=\.[a-z0-9]+$)/i, "")
      .replace(/\/+$/, "")
      .toLowerCase();

    return path ? `${host}${path}` : "";

  } catch {
    return String(value)
      .trim()
      .toLowerCase()
      .split(/[?#]/, 1)[0];
  }
}

function normalizeMeaningfulTitle(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(COMMON_COLORS_RE, " ")
    .replace(COMMON_SIZE_WORDS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (
    !normalized ||
    GENERIC_DEAL_TITLES.has(normalized)
  ) {
    return "";
  }

  if (
    normalized.length < 8 ||
    normalized.split(" ").length < 2
  ) {
    return "";
  }

  return normalized;
}

function dealTimestamp(deal) {
  const timestamp = new Date(
    deal.createdAt ||
    deal.fetchedAt ||
    0
  ).getTime();

  return Number.isFinite(timestamp)
    ? timestamp
    : 0;
}

function publicStoreOf(deal) {
  const store = String(deal.storeType || deal.store || "").toLowerCase();
  const url = String(deal.url || deal.productUrl || "").toLowerCase();
  if (store === "walmart" || url.includes("walmart.com") || url.includes("goto.walmart.com")) return "walmart";
  return store && store !== "other" ? store : "amazon";
}

function isPublicPromo(deal) {
  const code = String(deal.discountCode || "").trim().toLowerCase();
  return ((!!code && code !== "none") || deal.source === "email" || deal.source === "submission" || deal.sponsored === true);
}

function compactHomepagePayload(payload) {
  const deals = payload.deals || [];
  const newestFirst = items => [...items].sort((a, b) => dealTimestamp(b) - dealTimestamp(a));
  const amazon = newestFirst(deals.filter(deal => publicStoreOf(deal) === "amazon" && !["email", "seller", "submission"].includes(String(deal.source || "").toLowerCase()))).slice(0, HOME_STORE_DEALS_PER_STORE);
  const walmart = newestFirst(deals.filter(deal => publicStoreOf(deal) === "walmart")).slice(0, HOME_STORE_DEALS_PER_STORE);
  const promos = newestFirst(deals.filter(isPublicPromo)).slice(0, HOME_PROMO_DEALS);
  return {...payload, deals: deduplicateDeals([...amazon, ...walmart, ...promos]), totalDeals: deals.length};
}

function deduplicateDeals(candidates) {
  const sorted = [...candidates].sort(
    (a, b) =>
      (Number(b.discountPercent) || 0) -
        (Number(a.discountPercent) || 0) ||
      dealTimestamp(b) -
        dealTimestamp(a)
  );

  const seenAsins = new Set();
  const seenUrls = new Set();
  const seenImages = new Set();
  const seenTitles = new Set();
  const deduped = [];

  for (const deal of sorted) {
    const asin = normalizeAsin(deal.asin);

    const url = !asin
      ? normalizeAmazonUrl(deal.url)
      : "";

    const image =
      normalizeImage(deal.image);

    const title =
      normalizeMeaningfulTitle(deal.title);

    if (asin && seenAsins.has(asin))
      continue;

    if (url && seenUrls.has(url))
      continue;

    if (image && seenImages.has(image))
      continue;

    if (title && seenTitles.has(title))
      continue;

    if (asin)
      seenAsins.add(asin);

    if (url)
      seenUrls.add(url);

    if (image)
      seenImages.add(image);

    if (title)
      seenTitles.add(title);

    deduped.push(deal);
  }

  return deduped;
}

function isGarbageSubmission(record) {
  const title =
    (record.productTitle ||
      record.title ||
      "").trim();

  if (!title || title.length < 8)
    return true;

  if (GARBAGE_TITLE_RE.test(title))
    return true;

  const url =
    record.productUrl ||
    record.url ||
    "";

  if (!url)
    return true;

  return false;
}

async function getApprovedSellerDeals() {
  try {
    const store =
      getStore("submissions");

    const index =
      await store.get("index", {
        type: "json",
      });

    if (!Array.isArray(index))
      return [];

    const recentIds = index;
    const now = Date.now();

    const CONCURRENCY = 400;
    const approved = [];

    for (
      let i = 0;
      i < recentIds.length;
      i += CONCURRENCY
    ) {
      const batch =
        recentIds.slice(
          i,
          i + CONCURRENCY
        );

      const records =
        await Promise.all(
          batch.map(id =>
            store
              .get(id, {
                type: "json",
              })
              .catch(() => null)
          )
        );

      for (const record of records) {
        if (
          !record ||
          record.status !== "approved"
        ) {
          continue;
        }

        const recordImage =
          record.image ||
          record.photoUrl ||
          record.imageUrl ||
          "";

        // No approved submission can become a blank public card. Importers
        // put missing-image Amazon and Walmart deals in Pending; this guard
        // also protects manually approved legacy records.
        if (
          !String(recordImage).trim()
        ) {
          continue;
        }

        if (isGarbageSubmission(record))
          continue;

        const expiresAt =
          new Date(
            record.expiresOn
          ).getTime();

        if (
          !isNaN(expiresAt) &&
          expiresAt < now
        ) {
          continue;
        }

        const storedUrl =
          record.productUrl ||
          record.url ||
          "";

        const urlAsin =
          storedUrl.match(
            /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i
          )?.[1] || null;

        const validAsin =
          record.asin &&
          /^[A-Z0-9]{10}$/i.test(
            record.asin
          )
            ? record.asin
            : urlAsin;

        approved.push({
          id: record.id,
          asin: validAsin || null,
          title:
            record.productTitle ||
            record.title,
          image:
            recordImage || null,
          price: record.price,
          originalPrice:
            record.originalPrice ||
            null,
          discountPercent:
            record.discountPercent ||
            (record.discount
              ? parseInt(
                  record.discount
                )
              : null),
          rating: null,
          reviewCount: null,
          url: storedUrl,
          discountCode:
            record.discountCode ||
            null,
          sponsored:
            record.sponsored ||
            false,
          source:
            record.source ||
            "seller",
          storeType:
            record.storeType ||
            record.store ||
            "amazon",
          createdAt:
            record.createdAt ||
            null,
        });
      }
    }

    return approved;

  } catch {
    return [];
  }
}

async function rebuildPublicFeed(
  publicCache
) {
  const store =
    getStore("deals");

  const data =
    await store.get(
      "latest",
      {
        type: "json",
      }
    );

  const sellerDeals =
    await getApprovedSellerDeals();

  const reportedAmazonDeals =
    await getReportedAmazonDeals();

  const base = data || {
    generatedAt: null,
    deals: [],
    message:
      "No deals fetched yet — first scheduled run hasn't completed.",
  };

  const amazonCutoff =
    Date.now() -
    AMAZON_PUBLIC_WINDOW_MS;

  const amazonDeals =
    (base.deals || [])

      .filter(
        deal =>
          !deal.needsReview
      )

      // Existing catalog records from an earlier import can lack artwork.
      // Keep them out of the public feed rather than rendering blank cards.
      .filter(
        deal =>
          String(deal.image || "").trim()
      )

      .filter(deal => {
        const asin =
          normalizeAsin(
            deal.asin ||
            deal.id
          );

        const url =
          normalizeAmazonUrl(
            deal.url
          );

        if (
          asin &&
          reportedAmazonDeals.ids.has(
            asin
          )
        ) {
          return false;
        }

        if (
          url &&
          reportedAmazonDeals.urls.has(
            url
          )
        ) {
          return false;
        }

        return true;
      })

      .filter(deal => {
        const fetchedAt =
          new Date(
            deal.fetchedAt || 0
          ).getTime();

        return (
          Number.isFinite(fetchedAt) &&
          fetchedAt >= amazonCutoff
        );
      })

      .sort(
        (a, b) =>
          new Date(
            b.fetchedAt || 0
          ) -
          new Date(
            a.fetchedAt || 0
          )
      )

      .slice(
        0,
        MAX_PUBLIC_AMAZON_DEALS
      );

  const allDeals = [
    ...sellerDeals,
    ...amazonDeals,
  ];

  const deduped =
    deduplicateDeals(allDeals);

  const combined = {
    ...base,
    generatedAt:
      new Date().toISOString(),
    deals: deduped,
  };

  await publicCache
    .setJSON(
      PUBLIC_FEED_CACHE_KEY,
      {
        cachedAt: Date.now(),
        payload: combined,
      }
    )
    .catch(err =>
      console.log(
        "Public feed cache write failed:",
        err.message
      )
    );

  return combined;
}

export default async (
  req,
  context
) => {
  const homepageOnly = new URL(req.url).searchParams.get("view") === "home";
  const publicCache =
    getStore(
      "public-deals-cache"
    );

  let cachedFeed = null;

  try {
    cachedFeed =
      await publicCache
        .get(
          PUBLIC_FEED_CACHE_KEY,
          {
            type: "json",
          }
        )
        .catch(() => null);

    if (cachedFeed?.payload) {
      const cacheAge =
        Date.now() -
        cachedFeed.cachedAt;

      if (
        cacheAge >=
          PUBLIC_FEED_CACHE_TTL_MS &&
        context?.waitUntil
      ) {
        context.waitUntil(
          rebuildPublicFeed(
            publicCache
          ).catch(err =>
            console.log(
              "Background public feed refresh failed:",
              err.message
            )
          )
        );
      }

      const responsePayload = homepageOnly ? compactHomepagePayload(cachedFeed.payload) : cachedFeed.payload;
      return new Response(
        JSON.stringify(
          responsePayload
        ),
        {
          headers:
            cacheAge >=
            PUBLIC_FEED_CACHE_TTL_MS
              ? STALE_RESPONSE_HEADERS
              : RESPONSE_HEADERS,
        }
      );
    }

    const combined =
      await rebuildPublicFeed(
        publicCache
      );

    return new Response(
      JSON.stringify(homepageOnly ? compactHomepagePayload(combined) : combined),
      {
        headers:
          RESPONSE_HEADERS,
      }
    );

  } catch (err) {
    if (cachedFeed?.payload) {
      return new Response(
        JSON.stringify(homepageOnly ? compactHomepagePayload(cachedFeed.payload) : cachedFeed.payload),
        {
          headers:
            RESPONSE_HEADERS,
        }
      );
    }

    return new Response(
      JSON.stringify({
        deals: [],
        error: err.message,
      }),
      {
        status: 500,
        headers: {
          "Content-Type":
            "application/json",
        },
      }
    );
  }
};
