const GRAPH_API = "https://graph.facebook.com/v22.0";
const INSTAGRAM_PAGE_ID = process.env.DEALS_AHOLIC_FACEBOOK_PAGE_ID || "160279081349416";

// Read-only connection check. It never exposes the Meta token and never creates
// media or publishes a post.
export default async function handler() {
  const token = process.env.META_SYSTEM_TOKEN;
  if (!token) {
    return Response.json({ ok: false, error: "META_SYSTEM_TOKEN is not configured" }, { status: 500 });
  }

  const response = await fetch(
    `${GRAPH_API}/${INSTAGRAM_PAGE_ID}?fields=id,name,instagram_business_account&access_token=${encodeURIComponent(token)}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    return Response.json({ ok: false, error: data.error?.message || `Meta request failed (${response.status})` }, { status: 502 });
  }

  return Response.json({
    ok: Boolean(data.instagram_business_account?.id),
    facebookPage: { id: data.id, name: data.name },
    instagramAccountId: data.instagram_business_account?.id || null,
  });
}
