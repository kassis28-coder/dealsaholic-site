/**
 * Creates a PayPal order for a seller submission package.
 * Called by the public submit.html page when a seller clicks
 * "Pay with PayPal". Returns an order ID that the PayPal button
 * on the page uses to redirect into PayPal's checkout flow.
 *
 * Reachable at: /.netlify/functions/create-paypal-order
 *
 * Required environment variables:
 *   PAYPAL_CLIENT_ID
 *   PAYPAL_CLIENT_SECRET
 */

const CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API = "https://api-m.paypal.com"; // Live endpoint (not sandbox)

// Package definitions live here, server-side, so a seller can't
// tamper with the price by editing the page before submitting.
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

export default async (req) => {
  try {
    const body = await req.json();
    const packageKey = body.package;
    const pkg = PACKAGES[packageKey];

    if (!pkg) {
      return new Response(
        JSON.stringify({ error: "Invalid package selected." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const accessToken = await getAccessToken();

    const orderRes = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            description: `Deals-aholic Seller Package: ${pkg.label}`,
            amount: {
              currency_code: "USD",
              value: pkg.amount,
            },
            custom_id: packageKey,
          },
        ],
      }),
    });

    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error("PayPal order creation failed:", errText);
      return new Response(
        JSON.stringify({ error: "Could not create PayPal order." }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const order = await orderRes.json();

    return new Response(JSON.stringify({ orderId: order.id }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("create-paypal-order failed:", err.message);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
