export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();

    if (body.password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    let { title, url, price, originalPrice, discount, discountCode, imageUrl, imageBase64, imageType, expiresOn } = body;

    // Extract ASIN from Amazon URL
    const asinMatch = (url || "").match(/\/dp\/([A-Z0-9]{10})/i);
    const asin = asinMatch ? asinMatch[1] : null;

    // Build affiliate URL
    const affiliateUrl = asin
      ? `https://www.amazon.com/dp/${asin}?tag=kethya08-20`
      : url.includes("tag=") ? url : `${url}${url.includes("?") ? "&" : "?"}tag=kethya08-20`;

    // If image was uploaded as base64, store it in Netlify Blobs
    if (imageBase64 && imageType) {
      try {
        const { getStore } = await import("@netlify/blobs");
        const imageStore = getStore("images");
        const imageId = `img-${Date.now()}`;
        
        // Convert base64 to buffer
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        await imageStore.set(imageId, buffer, {
          metadata: { contentType: imageType }
        });
        
        imageUrl = `/.netlify/functions/get-image?id=${imageId}`;
      } catch (e) {
        console.log("Image upload failed:", e.message);
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
