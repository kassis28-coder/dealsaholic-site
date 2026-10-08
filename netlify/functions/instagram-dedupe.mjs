const INSTAGRAM_GRAPH_API = "https://graph.instagram.com/v25.0";

export function dealIdsFromCaption(caption) {
  const ids = new Set();
  const pattern = /https?:\/\/(?:www\.)?deals-aholic\.com\/d\/([^\s?#/]+)/gi;
  for (const match of String(caption || "").matchAll(pattern)) {
    try { ids.add(decodeURIComponent(match[1])); } catch { ids.add(match[1]); }
  }
  return ids;
}

export async function fetchPublishedInstagramDealIds(token, options = {}) {
  if (!token) throw new Error("INSTAGRAM_ACCESS_TOKEN is required for duplicate protection");
  const fetchImpl = options.fetchImpl || fetch;
  const maxPages = Number(options.maxPages || 3);
  let url = `${INSTAGRAM_GRAPH_API}/me/media?fields=caption,timestamp&limit=100&access_token=${encodeURIComponent(token)}`;
  const ids = new Set();

  for (let page = 0; url && page < maxPages; page += 1) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `Instagram duplicate check failed (${response.status})`);
    for (const media of Array.isArray(payload.data) ? payload.data : []) {
      for (const id of dealIdsFromCaption(media.caption)) ids.add(id);
    }
    url = typeof payload.paging?.next === "string" ? payload.paging.next : null;
  }
  return ids;
}
