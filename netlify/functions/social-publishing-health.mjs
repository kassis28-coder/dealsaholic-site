const INSTAGRAM_GRAPH_API = "https://graph.instagram.com/v25.0";

// Read-only connection check. It never exposes the Instagram token and never
// creates media or publishes a post.
export default async function handler() {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    return Response.json({ ok: false, error: "INSTAGRAM_ACCESS_TOKEN is not configured" }, { status: 500 });
  }

  const response = await fetch(
    `${INSTAGRAM_GRAPH_API}/me?fields=id,username&access_token=${encodeURIComponent(token)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    return Response.json({ ok: false, error: data.error?.message || `Instagram request failed (${response.status})` }, { status: 502 });
  }

  return Response.json({
    ok: Boolean(data.id),
    instagramAccountId: data.id || null,
    instagramUsername: data.username || null,
  });
}
