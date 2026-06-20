import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const { token } = body;

    if (!token) {
      return new Response(JSON.stringify({ error: "Missing token" }), { status: 400 });
    }

    const store = getStore("tokens");
    const record = await store.get(`token-${token}`, { type: "json" });

    if (!record) {
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 404 });
    }

    const creditsRemaining = record.creditsTotal - record.creditsUsed;

    if (creditsRemaining <= 0) {
      return new Response(JSON.stringify({ error: "No credits remaining" }), { status: 400 });
    }

    // Use one credit
    const updated = {
      ...record,
      creditsUsed: record.creditsUsed + 1,
      lastUsedAt: new Date().toISOString(),
    };

    await store.setJSON(`token-${token}`, updated);

    return new Response(JSON.stringify({
      success: true,
      creditsRemaining: creditsRemaining - 1,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/use-token",
};
