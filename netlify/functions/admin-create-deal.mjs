export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();

    // Verify admin password
    if (body.password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    let { title, url, price, originalPrice, discount, discountCode, imageUrl, expiresOn } = body;

    // Extract ASIN from Amazon URL
    const asinMatch = (url || "").match(/\/dp\/([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1] : null;

    // Build affiliate URL
    const affiliateUrl = asin
      ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
      : url.includes("tag=") ? url : `${url}${url.includes("?") ? "&" : "?"}tag=kethya08-20`;

    // Auto-fetch image from Amazon if not provided
    if (asin && !imageUrl) {
      try {
        const productRes = await fetch(`https://www.amazon.com/dp/${asin}`, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.5",
          },
        });

        if (productRes.ok) {
          const html = await productRes.text();
          const patterns = [
            /"hiRes":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/,
            /"large":"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg)"/,
            /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+\-_.]+\._AC_SL1500_\.jpg/,
            /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+\-_.]+\._AC_SY879_\.jpg/,
            /https:\/\/m\.media-amazon\.com\/images\/I\/[A-Za-z0-9%+\-_.]+\.jpg/,
          ];

          for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match) {
              imageUrl = match[1] || match[0];
              break;
            }
          }
        }
      } catch (e) {
        console.log("Image fetch failed:", e.message);
      }
    }

    // Handle expiry date
    let expiresOnISO;
    if (expiresOn) {
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

    const id = `admin-${Date.now()}`;
    const submission = {
      id,
      title,
      price,
      originalPrice,
      discount,
      url: affiliateUrl,
      imageUrl: imageUrl || null,
      discountCode: discountCode || null,
      source: "admin",
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
    console.error("admin-create-deal error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/admin-create-deal",
};
