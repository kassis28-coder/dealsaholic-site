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

const PARTNER_TAG = process.env.AMAZON_PARTNER_TAG || "kethya08-20";

function isAmazonUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes("amazon.");
  } catch {
    return false;
  }
}

function addAffiliateTag(url) {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("tag", PARTNER_TAG);
    return parsed.toString();
  } catch {
    return url;
  }
}

function generateSubmissionId() {
  return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

async function sendTokenEmail(sellerEmail, token, credits, packageLabel) {
  const submitUrl = `https://deals-aholic.com/submit.html?token=${token}`;
  
  // Use Gmail via a simple mailto approach - we'll use Netlify's built-in
  // For now we save the email to be sent via Make webhook
  const emailStore = getStore("pending-emails");
  await emailStore.setJSON(`email-${Date.now()}`, {
    to: sellerEmail,
    subject: "Your Deals-aholic Submission Link",
    body: `Thank you for your purchase!\n\nYour package: ${packageLabel}\nCredits: ${credits} post(s)\n\nUse this link to submit your deals:\n${submitUrl}\n\nThis link is unique to you. Each submission uses 1 credit.\n\nThank you,\nDeals-aholic Team`,
    token,
    submitUrl,
    createdAt: new Date().toISOString(),
  });
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

    // Validate required fields
    const required = ["productTitle", "productUrl", "discountCode", "price", "expiresOn", "sellerEmail"];
    for (const field of required) {
      if (!submission[field] || String(submission[field]).trim() === "") {
        return new Response(
          JSON.stringify({ error: `Missing required field: ${field}` }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    const accessToken = await getAccessToken();

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

    // Generate token for multi-post packages
    const token = generateToken();
    const tokenStore = getStore("tokens");
    await tokenStore.setJSON(`token-${token}`, {
      token,
      sellerEmail: submission.sellerEmail,
      packageType: packageKey,
      packageLabel: pkg.label,
      amountPaid,
      creditsTotal: pkg.posts,
      creditsUsed: 1, // First post counts as 1 used
      createdAt: new Date().toISOString(),
      status: "active",
    });

    // Save first submission
    const submissionId = generateSubmissionId();
    const productUrl = submission.productUrl;
    const isAmazon = isAmazonUrl(productUrl);
    const record = {
      id: submissionId,
      status: "pending",
      submittedAt: new Date().toISOString(),
      paypalOrderId: orderId,
      packageKey,
      packageLabel: pkg.label,
      postsAllowed: pkg.posts,
      amountPaid,
      token,
      productTitle: submission.productTitle,
      originalUrl: productUrl,
      productUrl: isAmazon ? addAffiliateTag(productUrl) : productUrl,
      needsAffiliateLink: !isAmazon,
      discountCode: submission.discountCode,
      price: submission.price,
      photoUrl: submission.photoUrl || null,
      expiresOn: submission.expiresOn,
      sellerEmail: submission.sellerEmail || null,
    };

    const store = getStore("submissions");
    await store.setJSON(submissionId, record);

    let index = [];
    try {
      const existingIndex = await store.get("index", { type: "json" });
      if (Array.isArray(existingIndex)) index = existingIndex;
    } catch {}
    index.push(submissionId);
    await store.setJSON("index", index);

    // Send token email if seller has more posts remaining
    if (pkg.posts > 1 && submission.sellerEmail) {
      await sendTokenEmail(
        submission.sellerEmail,
        token,
        pkg.posts - 1, // remaining credits after first post
        pkg.label
      );
    }

    const submitUrl = `https://deals-aholic.com/submit.html?token=${token}`;

    return new Response(
      JSON.stringify({ 
        ok: true, 
        submissionId, 
        status: "pending",
        token: pkg.posts > 1 ? token : null,
        submitUrl: pkg.posts > 1 ? submitUrl : null,
        creditsRemaining: pkg.posts - 1,
      }),
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
