import { getStore } from "@netlify/blobs";

const WALMART_AFFILIATE_ID = "1788825";
const WALMART_IMPACT_TAG = `wmlspartner=iplc${WALMART_AFFILIATE_ID}`;

// Add affiliate tag to Walmart URL
function addWalmartAffiliate(url) {
  if (!url) return url;
  if (url.includes("wmlspartner=")) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${WALMART_IMPACT_TAG}`;
}

// Fetch Walmart deals page and parse products
async function fetchWalmartDeals() {
  const deals = [];

  const urls = [
    "https://www.walmart.com/shop/deals",
    "https://www.walmart.com/cp/rollbacks/1225519",
    "https://www.walmart.com/shop/deals/electronics",
    "https://www.walmart.com/shop/deals/home",
    "https://www.walmart.com/shop/deals/toys",
  ];

  for (const pageUrl of urls) {
    try {
      console.log(`Fetching: ${pageUrl}`);
      const res = await fetch(pageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
      });

      if (!res.ok) {
        console.log(`Failed to fetch ${pageUrl}: ${res.status}`);
        continue;
      }

      const html = await res.text();

      // Extract JSON data embedded in Walmart's page
      // Walmart embeds product data in __NEXT_DATA__ or window.__WML_REDUX_INITIAL_STATE__
      let products = [];

      // Try __NEXT_DATA__ first
      const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (nextDataMatch) {
        try {
          const nextData = JSON.parse(nextDataMatch[1]);
          // Navigate the nested structure to find products
          const props = nextData?.props?.pageProps?.initialData?.searchResult?.itemStacks;
          if (props) {
            for (const stack of props) {
              if (stack?.items) {
                products.push(...stack.items);
              }
            }
          }
          // Also try contentLayout path
          const contentLayout = nextData?.props?.pageProps?.initialData?.contentLayout?.modules;
          if (contentLayout) {
            for (const module of contentLayout) {
              if (module?.configs?.products) {
                products.push(...module.configs.products);
              }
            }
          }
        } catch (e) {
          console.log("Could not parse __NEXT_DATA__:", e.message);
        }
      }

      // Try extracting from inline JSON blobs
      if (products.length === 0) {
        const jsonMatches = html.matchAll(/"item":\{"id":"([^"]+)","usItemId":"([^"]+)","name":"([^"]+)"[^}]*"salePrice":(\d+\.?\d*)[^}]*"imageUrl":"([^"]+)"/g);
        for (const match of jsonMatches) {
          products.push({
            usItemId: match[2],
            name: match[3],
            salePrice: parseFloat(match[4]),
            imageUrl: match[5],
          });
        }
      }

      console.log(`Found ${products.length} raw products from ${pageUrl}`);

      for (const item of products) {
        try {
          const id = item?.usItemId || item?.itemId || item?.id;
          const name = item?.name || item?.title || item?.displayName;
          const salePrice = item?.priceInfo?.currentPrice?.price || item?.salePrice || item?.price?.currentPrice;
          const originalPrice = item?.priceInfo?.wasPrice?.price || item?.wasPrice || item?.price?.wasPrice;
          const imageUrl = item?.imageInfo?.thumbnailUrl || item?.imageUrl || item?.image;
          const rating = item?.rating?.averageRating || item?.averageRating || 0;
          const numRatings = item?.rating?.numberOfRatings || item?.numRatings || 0;

          if (!id || !name || !salePrice) continue;

          // Calculate discount
          let discountPercent = 0;
          if (originalPrice && originalPrice > salePrice) {
            discountPercent = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
          }

          // Filter: minimum 20% off, rating 3.5+, must have image
          if (discountPercent < 20) continue;
          if (rating > 0 && rating < 3.5) continue;
          if (!imageUrl) continue;

          // Block adult content
          const blocked = ["adult", "sex", "xxx", "erotic", "lingerie"];
          if (blocked.some(w => name.toLowerCase().includes(w))) continue;

          const dealUrl = addWalmartAffiliate(`https://www.walmart.com/ip/${id}`);

          deals.push({
            id: `walmart-${id}`,
            title: name,
            price: `$${parseFloat(salePrice).toFixed(2)}`,
            originalPrice: originalPrice ? `$${parseFloat(originalPrice).toFixed(2)}` : null,
            discountPercent: discountPercent,
            url: dealUrl,
            image: imageUrl,
            store: "walmart",
            status: "approved",
            sponsored: false,
            rating: rating,
            numRatings: numRatings,
            source: "walmart-scraper",
            createdAt: new Date().toISOString(),
            expiresOn: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
          });

        } catch (e) {
          console.log("Error parsing product:", e.message);
        }
      }

      // Small delay between requests to be polite
      await new Promise(r => setTimeout(r, 1000));

    } catch (e) {
      console.log(`Error fetching ${pageUrl}:`, e.message);
    }
  }

  return deals;
}

export default async function handler() {
  try {
    console.log("⏰ fetch-walmart-deals triggered");

    const store = getStore("submissions");

    // Get existing deal IDs to avoid duplicates
    const { blobs } = await store.list();
    const existingIds = new Set(blobs.map(b => b.key));
    console.log(`Existing submissions: ${existingIds.size}`);

    // Fetch Walmart deals
    const deals = await fetchWalmartDeals();
    console.log(`Total Walmart deals found: ${deals.length}`);

    if (deals.length === 0) {
      console.log("No Walmart deals found this run");
      return new Response(JSON.stringify({ success: true, added: 0, message: "No deals found" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Save new deals to Netlify Blobs
    let added = 0;
    for (const deal of deals) {
      if (existingIds.has(deal.id)) {
        console.log(`Skipping duplicate: ${deal.id}`);
        continue;
      }
      await store.set(deal.id, JSON.stringify(deal));
      added++;
      console.log(`✅ Added: ${deal.title} - ${deal.price} (${deal.discountPercent}% off)`);
    }

    console.log(`✅ Done! Added ${added} new Walmart deals`);

    return new Response(
      JSON.stringify({ success: true, added, total: deals.length }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error("❌ Error in fetch-walmart-deals:", err);
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export const config = {
  schedule: "0 */3 10-3 * *", // every 3 hours, 6am-11pm EST
};
