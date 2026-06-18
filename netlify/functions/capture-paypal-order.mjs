/**
 * Captures (finalizes) a PayPal order after the seller approves
 * payment on PayPal's side, then saves their submission details
 * as a PENDING entry for the site owner to review.
 *
 * Reachable at: /.netlify/functions/capture-paypal-order
 *
 * Required environment variables:
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 */

import { getStore } from "@netlify/blobs";

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API = "https://api-m.paypal.com";

const PACKAGES = {
  single: { posts: 1, amount: "3.00", label: "1 Post" },
  five: { posts: 5, amount: "12.00", label: "5 Posts" },
  ten: { posts: 10, amount: "25.00", label: "10 Posts" },
};

async function getAccessToken() {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    throw new Error(`PayPal auth failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

function generateSubmissionId() {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export default async (req) => {
  try {
    const body = await req.json();
    const { orderId, submission } = body;

    if (!orderId || !submission) {
      return new Response(
        JSON.stringify({ error: "Missing orderId or submission data." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Basic validation of required submission fields.
    const required = ["productTitle", "productUrl", "discountCode", "price", "expiresOn"];
    for (const field of required) {
      if (!submission[field] || String(submission[field]).trim() === "") {
        return new Response(
          JSON.stringify({ error: `Missing required field: ${field}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const accessToken = await getAccessToken();

    // Capture the order — this is the step that actually finalizes
    // the payment and moves money. We do NOT save the submission as
    // pending unless this succeeds.
    const captureRes = await fetch(
      `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!captureRes.ok) {
      const errText = await captureRes.text();
      console.error("PayPal capture failed:", errText);
      return new Response(
        JSON.stringify({ error: "Payment could not be confirmed." }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }

    const captureData = await captureRes.json();
    const status = captureData.status;

    if (status !== "COMPLETED") {
      return new Response(
        JSON.stringify({ error: `Payment not completed (status: ${status}).` }),
        { status: 402, headers: { "Content-Type": "application/json" } }
      );
    }

    const purchaseUnit = captureData.purchase_units?.[0];
    const packageKey = purchaseUnit?.payments?.captures?.[0]?.custom_id || purchaseUnit?.custom_id;
    const pkg = PACKAGES[packageKey] || { posts: 1, label: "Unknown package" };
    const amountPaid = purchaseUnit?.payments?.captures?.[0]?.amount?.value || null;

    const submissionId = generateSubmissionId();
    const record = {
      id: submissionId,
      status: "pending",
      submittedAt: new Date().toISOString(),
      paypalOrderId: orderId,
      packageKey,
      packageLabel: pkg.label,
      postsAllowed: pkg.posts,
      amountPaid,
      productTitle: submission.productTitle,
      productUrl: submission.productUrl,
      discountCode: submission.discountCode,
      price: submission.price,
      photoUrl: submission.photoUrl || null,
      expiresOn: submission.expiresOn,
      sellerEmail: submission.sellerEmail || null,
    };

    const store = getStore("submissions");
    await store.setJSON(submissionId, record);

    // Maintain an index of all submission IDs so the admin page
    // can list them without needing to know IDs in advance.
    let index = [];
    try {
      const existingIndex = await store.get("index", { type: "json" });
      if (Array.isArray(existingIndex)) index = existingIndex;
    } catch {
      // No index yet — fine on first submission.
    }
    index.push(submissionId);
    await store.setJSON("index", index);

    return new Response(
      JSON.stringify({ ok: true, submissionId, status: "pending" }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("capture-paypal-order failed:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
