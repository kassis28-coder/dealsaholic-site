export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const claudeResponse = body.title;

    // Parse Claude's extracted data
    let dealData;
    try {
      const clean = claudeResponse.replace(/```json|```/g, "").trim();
      dealData = JSON.parse(clean);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to parse Claude response" }), { status: 400 });
    }

    // Extract ASIN from Amazon URL
    const amazonUrl = dealData.amazonUrl || "";
    const asinMatch = amazonUrl.match(/\/dp\/([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1] : null;

    let imageUrl = dealData.imageUrl || null;
    let title = dealData.title;
    let price = dealData.price;
    let originalPrice = dealData.originalPrice;
    let discount = dealData.discount;
    let expiresOn = dealData.expiresOn || null;

    // Build affiliate URL
    const affiliateUrl = asin
      ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
      : amazonUrl.includes("tag=")
      ? amazonUrl
      : `${amazonUrl}${amazonUrl.includes("?") ? "&" : "?"}tag=kethya08-20`;

    // Try to get image from Amazon product page
    if (asin && !imageUrl) {
      try {
        const productRes = await fetch(`https://www.amazon.com/dp/${asin}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "Cache-Control": "no-cache",
          },
        });

        if (productRes.ok) {
          const html = await productRes.text();

          // Try multiple patterns to find image URL
          const patterns = [
            /"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/,
            /"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/,
            /"main":\{"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/,
            /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+\-_.]+\._AC_SL1500_\.jpg/,
            /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+\-_.]+\._AC_SY879_\.jpg/,
            /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+\-_.]+\.jpg/,
          ];

          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
              imageUrl = match[1] || match[0];
              // Clean up any truncation
              if (imageUrl && !imageUrl.endsWith('.jpg')) {
                imageUrl = imageUrl + '.jpg';
              }
              break;
            }
          }
        }
      } catch (e) {
        console.log("Image fetch failed:", e.message);
      }
    }

    // Calculate expiry
    let expiresOnISO;
    if (expiresOn) {
      // Handle MM/DD/YYYY or YYYY-MM-DD
      if (expiresOn.includes('/')) {
        const parts = expiresOn.split('/');
        if (parts.length === 3) {
          expiresOnISO = `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}T23:59:59.000Z`;
        }
      } else {
        expiresOnISO = new Date(expiresOn).toISOString();
      }
    }
    if (!expiresOnISO) {
      expiresOnISO = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    }

    // Save to Netlify Blobs
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("submissions");

    const id = `email-${Date.now()}`;
    const submission = {
      id,
      title,
      price,
      originalPrice,
      discount,
      url: affiliateUrl,
      imageUrl,
      discountCode: dealData.discountCode || null,
      source: dealData.source || "email",
      status: "approved",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: expiresOnISO,
    };

    await store.setJSON(id, submission);

    // Update index
    let index = [];
    try {
      index = await store.get("index", { type: "json" }) || [];
    } catch (e) { index = []; }
    index.unshift(id);
    await store.setJSON("index", index);

    return new Response(JSON.stringify({ success: true, id, deal: submission }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("submit-email-deal error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/submit-email-deal",
};
