import { getStore } from "@netlify/blobs";

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const { sellerEmail, packageType, amountPaid, orderId } = body;

    if (!sellerEmail || !packageType) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }

    // Determine credits based on package
    const credits = packageType === 'single' ? 1 : packageType === 'five' ? 5 : 10;

    // Generate unique token
    const token = generateToken();
    const id = `token-${token}`;

    // Save token to Blobs
    const store = getStore("tokens");
    await store.setJSON(id, {
      token,
      sellerEmail,
      packageType,
      amountPaid,
      orderId,
      creditsTotal: credits,
      creditsUsed: 0,
      createdAt: new Date().toISOString(),
      status: "active",
    });

    const submitUrl = `https://deals-aholic.com/submit.html?token=${token}`;

    return new Response(JSON.stringify({ 
      success: true, 
      token,
      submitUrl,
      credits,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("create-token error:", err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/create-token",
};
