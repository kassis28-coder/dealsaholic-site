import { getStore } from "@netlify/blobs";

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
      return new Response(JSON.stringify({ error: "Submission not found" }), { status: 404 });
    }

    let expiresOnISO = record.expiresOn;
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

    // Fall back to productUrl if record.url is absent
    let finalUrl = url || record.url || record.productUrl;
    if (url) {
      const asinMatch = url.match(/\/dp\/([A-Z0-9]{10})/i);
      const asin = asinMatch ? asinMatch[1] : null;
      if (asin) {
        finalUrl = `https://www.amazon.com/dp/${asin}?tag=daholic-20`;
      }
    }

    // Resolve final image and title using whichever field variant the record has
    const finalImage = imageUrl || record.imageUrl || record.photoUrl;
    const finalTitle = title || record.title || record.productTitle;

    const updated = {
      ...record,
      // Write BOTH field-name variants so the admin panel always reads fresh values
      // regardless of whether the record was created as a seller or email submission.
      title: finalTitle,
      productTitle: finalTitle,
      price: price || record.price,
      originalPrice: originalPrice || record.originalPrice,
      discount: discount || record.discount,
      discountCode: discountCode || record.discountCode,
      expiresOn: expiresOnISO,
      imageUrl: finalImage,
      photoUrl: finalImage,
      url: finalUrl,
      productUrl: finalUrl,
      updatedAt: new Date().toISOString(),
    };

    await store.setJSON(submissionId, updated);
    const readBack = await store.get(submissionId, { type: "json" });
console.log("[edit-submission] readBack for key=" + submissionId + ":", JSON.stringify(readBack));

    return new Response(JSON.stringify({ success: true, record: updated, readBack }), {
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
