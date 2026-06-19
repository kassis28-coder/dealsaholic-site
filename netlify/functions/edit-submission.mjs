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

    const { submissionId, title, price, originalPrice, discount, discountCode, expiresOn } = body;

    if (!submissionId) {
      return new Response(JSON.stringify({ error: "Missing submissionId" }), { status: 400 });
    }

    const store = getStore("submissions");

    // Get existing record
    let record;
    try {
      record = await store.get(submissionId, { type: "json" });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Submission not found" }), { status: 404 });
    }

    // Handle expiry date MM/DD/YYYY or YYYY-MM-DD
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

    // Update record
    const updated = {
      ...record,
      title: title || record.title || record.productTitle,
      price: price || record.price,
      originalPrice: originalPrice || record.originalPrice,
      discount: discount || record.discount,
      discountCode: discountCode || record.discountCode,
      expiresOn: expiresOnISO,
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
