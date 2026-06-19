import Anthropic from "@anthropic-ai/sdk";

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const claudeResponse = body.title; // This is Claude's JSON string from Make

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
    const asinMatch = amazonUrl.match(/\/dp\/([A-Z0-9]{10})/);
    const asin = asinMatch ? asinMatch[1] : null;

    let imageUrl = dealData.imageUrl || null;
    let title = dealData.title;
    let price = dealData.price;
    let originalPrice = dealData.originalPrice;
    let discount = dealData.discount;

    // If we have an ASIN, look up product details from Amazon API
    if (asin) {
      try {
        const tokenRes = await fetch("https://api.amazon.com/auth/o2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: process.env.AMAZON_CLIENT_ID,
            client_secret: process.env.AMAZON_CLIENT_SECRET,
            scope: "advertising::campaign_management",
          }),
        });

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        if (accessToken) {
          const searchRes = await fetch(
            `https://affiliate-program.amazon.com/home/search?term=${asin}`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
            }
          );

          // Try to get image from Amazon product URL directly
          const productRes = await fetch(`https://www.amazon.com/dp/${asin}`, {
            headers: {
              "User-Agent": "Mozilla/5.0",
              Accept: "text/html",
            },
          });

          const html = await productRes.text();
          const imgMatch = html.match(/https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+\.jpg/);
          if (imgMatch) {
            imageUrl = imgMatch[0];
          }
        }
      } catch (e) {
        console.log("Amazon API lookup failed, continuing without image:", e.message);
      }
    }

    // Build affiliate URL
    const affiliateUrl = asin
      ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
      : amazonUrl.includes("tag=")
      ? amazonUrl
      : `${amazonUrl}${amazonUrl.includes("?") ? "&" : "?"}tag=kethya08-20`;

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
      source: "email",
      status: "approved",
      sponsored: false,
      createdAt: new Date().toISOString(),
      expiresOn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
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
