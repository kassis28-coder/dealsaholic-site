import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");

  if (!token) {
    return new Response(JSON.stringify({ error: "Missing token" }), { status: 400 });
  }

  try {
    const store = getStore("tokens");
    const record = await store.get(`token-${token}`, { type: "json" });

    if (!record) {
      return new Response(JSON.stringify({ valid: false, error: "Invalid token" }), { status: 404 });
    }

    const creditsRemaining = record.creditsTotal - record.creditsUsed;

    return new Response(JSON.stringify({
      valid: true,
      token,
      sellerEmail: record.sellerEmail,
      packageType: record.packageType,
      creditsTotal: record.creditsTotal,
      creditsUsed: record.creditsUsed,
      creditsRemaining,
      status: record.status,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ valid: false, error: err.message }), { status: 500 });
  }
};

export const config = {
  path: "/api/validate-token",
};
