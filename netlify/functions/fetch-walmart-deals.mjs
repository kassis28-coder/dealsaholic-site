import { getStore } from "@netlify/blobs";

function addWalmartAffiliate(url) {
  if (!url) return url;
  if (url.includes("wmlspartner=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}wmlspartner=iplc1788825`;
}

async function runFetchWalmartDeals() {
  const store = getStore("submissions");
  const { blobs } = await store.list();
  const existingIds = new Set(blobs.map((b) => b.key));

  const urls = [
    "https://www.walmart.com/shop/deals",
    "https://www.walmart.com/cp/rollbacks/1225519",
    "https://www.walmart.com/shop/deals/electronics",
    "https://www.walmart.com/shop/deals/home",
    "https://www.walmart.com/shop/deals/toys",
  ];

  let added = 0;
  let total = 0;

  for (const pageUrl of urls) {
    try {
      const res = await fetch(pageUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
      });

      if (!res.ok) continue;

      const html = await res.text();
      let products = [];

      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (match) {
        try {
          const data = JSON.parse(match[1]);
          const stacks = data?.props?.pageProps?.initialData?.searchResult?.itemStacks;
          if (stacks) {
            for (const stack of stacks) {
              if (stack?.items) products.push(...stack.items);
            }
          }
        } catch (e) {
          console.log("JSON parse error:", e.message);
        }
      }

      for (const item of products) {
        const id = item?.usItemId || item?.itemId;
        const name = item?.name || item?.title;
        const salePrice = item?.priceInfo?.currentPrice?.price || item?.salePrice;
        const wasPrice = item?.priceInfo?.wasPrice?.price || item?.wasPrice;
        const image = item?.imageInfo?.thumbnailUrl || item?.imageUrl;
        const rating = item?.rating?.averageRating || 0;

        if (!id || !name || !salePrice || !image) continue;

        let discount = 0;
        if (wasPrice && wasPrice > salePrice) {
          discount = Math.round(((wasPrice - salePrice) / wasPrice) * 100);
        }

        if (discount < 20) continue;
        if (rating > 0 && rating < 3.5) continue;

        const blocked = ["adult", "sex", "xxx", "erotic"];
        if (blocked.some((w) => name.toLowerCase().includes(w))) continue;

        total++;
        const dealId = `walmart-${id}`;
        if (existingIds.has(dealId)) continue;

        const deal = {
          id: dealId,
          title: name,
          price: `$${parseFloat(salePrice).toFixed(2)}`,
          originalPrice: wasPrice ? `$${parseFloat(wasPrice).toFixed(2)}` : null,
          discountPercent: discount,
          url: addWalmartAffiliate(`https://www.walmart.com/ip/${id}`),
          image: image,
          store: "walmart",
          status: "approved",
          sponsored: false,
          rating: rating,
          source: "walmart-scraper",
          createdAt: new Date().toISOString(),
          expiresOn: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };

        await store.set(dealId, JSON.stringify(deal));
        added++;
        console.log(`Added: ${name} - $${salePrice} (${discount}% off)`);
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (e) {
      console.log(`Error fetching ${pageUrl}:`, e.message);
    }
  }

  return { success: true, added, total };
}

export default async function handler(req) {
  if (req && req.url) {
    const url = new URL(req.url);
    const password = url.searchParams.get("password");
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    try {
      const result = await runFetchWalmartDeals();
      return new Response(JSON.stringify(result), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  try {
    await runFetchWalmartDeals();
  } catch (err) {
    console.error("Scheduled run error:", err);
  }
}

export const config = {
  schedule: "0 */3 * * *",
};
