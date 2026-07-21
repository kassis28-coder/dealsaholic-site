import { getStore } from "@netlify/blobs";

// ─── Fetch product image from Amazon product page ─────────────────────────────
// Called when the admin edits a deal and no imageUrl is provided.
// Fetches og:image or first CDN image from the Amazon product page.
// Returns a direct URL link — no download or re-hosting needed.

async function fetchAmazonProductImage(asin) {
  if (!asin) return null;
  try {
    const res = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    // Try og:image meta tag — most reliable
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]?.startsWith('http')) return ogMatch[1];

    // Fallback: first large m.media-amazon.com CDN image
    const cdnPattern = /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%._-]+\.(?:jpg|jpeg|png|webp)/gi;
    for (const img of (html.match(cdnPattern) || [])) {
      const clean = img.split('?')[0];
      if (!/_SL75_|_SS40_|_AC_US\d+_|thumbnail/i.test(clean)) return clean;
    }
    return null;
  } catch (e) {
    console.log(`fetchAmazonProductImage(${asin}) failed: ${e.message}`);
    return null;
  }
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  try {
    const body = await req.json();
    if (body.password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const { submissionId, title, price, originalPrice, discount, discountCode, expiresOn, imageUrl, url } = body;

    if (!submissionId) {
      return new Response(JSON.stringify({ error: "Missing submissionId" }), { status: 400 });
    }

    const store = getStore("submissions");
    let record;
    try {
      record = await store.get(submissionId, { type: "json" });
    } catch (e) {
      record = null;
    }
    if (!record) {
      return new Response(JSON.stringify({ error: "Submission not found" }), { status: 404 });
    }

    let expiresOnISO = record.expiresOn;
    if (expiresOn) {
      try {
        if (expiresOn.includes('/')) {
          const parts = expiresOn.split('/');
          if (parts.length === 3) {
            expiresOnISO = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}T23:59:59.000Z`;
          }
        } else {
          expiresOnISO = new Date(expiresOn).toISOString();
        }
      } catch (e) { /* keep existing expiresOn on bad input */ }
    }

    // Build affiliate URL if an Amazon link was provided
    let finalUrl = url || record.url;
    let asin = record.asin || null;
    if (url) {
      const asinMatch = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
      asin = asinMatch ? asinMatch[1] : asin;
      if (asin) {
        finalUrl = `https://www.amazon.com/dp/${asin}?tag=${process.env.AMAZON_PARTNER_TAG || 'daholic-20'}`;
      }
    }

    // Resolve image: use provided imageUrl, or fall back to existing, or auto-fetch from Amazon
    let resolvedImageUrl = imageUrl || record.imageUrl || record.image || null;
    if (!resolvedImageUrl && asin) {
      console.log(`[edit-submission] No imageUrl — auto-fetching from Amazon for ASIN ${asin}`);
      resolvedImageUrl = await fetchAmazonProductImage(asin);
      console.log(`[edit-submission] Auto-fetched imageUrl: ${resolvedImageUrl}`);
    }

    const updated = {
      ...record,
      title: title || record.title || record.productTitle,
      price: price || record.price,
      originalPrice: originalPrice || record.originalPrice,
      discount: discount || record.discount,
      discountCode: discountCode || record.discountCode,
      expiresOn: expiresOnISO,
      imageUrl: resolvedImageUrl,
      asin,
      url: finalUrl,
      updatedAt: new Date().toISOString(),
    };

    await store.setJSON(submissionId, updated);

    return new Response(JSON.stringify({ success: true, record: updated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("edit-submission error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/edit-submission",
};
