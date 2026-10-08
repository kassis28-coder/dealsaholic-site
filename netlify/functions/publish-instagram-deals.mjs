import { getStore } from "@netlify/blobs";
import { fetchPublishedInstagramDealIds } from "./instagram-dedupe.mjs";
import {
  RETRY_WINDOW_MINUTES,
  SLOT_HOURS,
  buildCaption,
  easternNow,
  nextInstagramAction,
} from "./instagram-plan-utils.mjs";

// This function is intentionally Instagram-only. It does not read, write, or
// call any Facebook page, token, scheduler, or Graph API path.
const INSTAGRAM_GRAPH_API = "https://graph.instagram.com/v25.0";
const PLAN_STORE = "instagram-daily-plan";

async function postForm(path, params) {
  const response = await fetch(`${INSTAGRAM_GRAPH_API}/${path}`, {
    method: "POST",
    signal: AbortSignal.timeout(25_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Instagram request failed (${response.status})`);
  return data;
}

async function instagramProfile(token) {
  const response = await fetch(`${INSTAGRAM_GRAPH_API}/me?fields=id,username&access_token=${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || !data.id) throw new Error(data.error?.message || "Instagram account could not be resolved");
  if (String(data.username || "").toLowerCase() !== "deals_aholic") {
    throw new Error(`Connected Instagram account is @${data.username || "unknown"}, expected @deals_aholic`);
  }
  return data;
}

async function createContainer(profileId, imageUrl, caption, token) {
  const container = await postForm(`${profileId}/media`, { image_url: imageUrl, caption, access_token: token });
  if (!container.id) throw new Error("Instagram did not return a media container ID");
  return container.id;
}

async function validateCreativeUrl(imageUrl) {
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(20_000), headers: { Accept: "image/jpeg" } });
  const contentType = response.headers.get("content-type") || "";
  const bytes = Number(response.headers.get("content-length") || 0);
  if (!response.ok || !contentType.startsWith("image/jpeg")) throw new Error(`Validated creative URL is not publishable (${response.status}, ${contentType || "no content type"})`);
  if (bytes && bytes < 25_000) throw new Error("Validated creative URL returned an unexpectedly small image");
}

async function containerStatus(containerId, token) {
  const response = await fetch(`${INSTAGRAM_GRAPH_API}/${containerId}?fields=status_code&access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error?.message || `Instagram container status failed (${response.status})`);
  return String(data.status_code || "").toUpperCase();
}

async function publishContainer(profileId, containerId, token) {
  const published = await postForm(`${profileId}/media_publish`, { creation_id: containerId, access_token: token });
  if (!published.id) throw new Error("Instagram did not return a published media ID");
  return published.id;
}

function planComplete(plan) {
  return Object.values(plan.slots).every((slot) => slot.instagram_status === "published");
}

async function save(store, key, plan) {
  plan.updated_at = new Date().toISOString();
  plan.status = planComplete(plan) ? "published" : "in_progress";
  await store.setJSON(key, plan);
}

export default async function handler() {
  const now = easternNow();
  if (!SLOT_HOURS.includes(now.hour) || now.minute > RETRY_WINDOW_MINUTES) {
    return Response.json({ skipped: "outside Instagram publishing window", now });
  }

  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) return Response.json({ error: "INSTAGRAM_ACCESS_TOKEN is not configured" }, { status: 503 });

  const store = getStore(PLAN_STORE);
  const key = `plan-${now.date}`;
  const plan = await store.get(key, { type: "json" }).catch(() => null);
  const slot = plan?.slots?.[now.hour];
  if (!slot) return Response.json({ skipped: "no prepared plan for this Instagram slot", date: now.date, hour: now.hour }, { status: 409 });

  const action = nextInstagramAction(slot);
  if (action === "done") {
    return Response.json({ skipped: "Instagram slot already published", instagram_media_id: slot.instagram_media_id });
  }

  if (action === "blocked_creative") {
    slot.instagram_status = "blocked_creative";
    slot.last_error = "A generated and validated 1080x1350 creative is required";
    await save(store, key, plan);
    return Response.json({ blocked: slot.last_error, date: now.date, hour: now.hour }, { status: 409 });
  }

  // Re-check the live Instagram captions immediately before publishing. This
  // protects against a deal being posted manually after the daily plan was
  // prepared. Fail closed: a duplicate is never replaced by a second post.
  try {
    const publishedDealIds = await fetchPublishedInstagramDealIds(token);
    if (publishedDealIds.has(String(slot.deal_id))) {
      slot.instagram_status = "duplicate_detected";
      slot.last_error = "Deal already exists on Instagram; a different product must be planned";
      await save(store, key, plan);
      return Response.json({ blocked: slot.last_error, deal_id: slot.deal_id }, { status: 409 });
    }
  } catch (error) {
    slot.instagram_status = "retrying";
    slot.last_error = `Instagram duplicate check failed; ${error.message}`;
    slot.retry_count = Number(slot.retry_count || 0) + 1;
    await save(store, key, plan);
    return Response.json({ error: slot.last_error }, { status: 502 });
  }

  // LinkDM is optional. When no draft exists the frozen caption sends shoppers
  // directly to deals-aholic.com and never promises an unavailable DM.
  const profile = await instagramProfile(token).catch(async (error) => {
    slot.instagram_status = "retrying";
    slot.retry_count = Number(slot.retry_count || 0) + 1;
    slot.last_error = error.message;
    slot.last_attempt_at = new Date().toISOString();
    await save(store, key, plan);
    return null;
  });
  if (!profile) return Response.json({ error: slot.last_error, retry_count: slot.retry_count }, { status: 502 });

  // Do not create a second container when a prior run may have already created
  // one. A stored container is retried only at media_publish, which prevents a
  // duplicate Instagram post for the same frozen deal.
  if (action === "create_container" || action === "manual_recovery_required") {
    if (action === "manual_recovery_required") {
      slot.instagram_status = "manual_recovery_required";
      slot.last_error = "Container creation result is unknown; refusing to create duplicate Instagram media";
      await save(store, key, plan);
      return Response.json({ error: slot.last_error }, { status: 409 });
    }

    try {
      await validateCreativeUrl(slot.social_image_url);
    } catch (error) {
      slot.instagram_status = "retrying";
      slot.retry_count = Number(slot.retry_count || 0) + 1;
      slot.last_error = error.message;
      slot.last_attempt_at = new Date().toISOString();
      await save(store, key, plan);
      return Response.json({ error: error.message, retry_count: slot.retry_count }, { status: 502 });
    }

    slot.instagram_status = "creating_container";
    slot.last_attempt_at = new Date().toISOString();
    slot.caption = buildCaption(slot);
    await save(store, key, plan);
    try {
      slot.instagram_container_id = await createContainer(profile.id, slot.social_image_url, slot.caption, token);
      slot.instagram_status = "container_created";
      slot.last_error = null;
      await save(store, key, plan);
    } catch (error) {
      // A transport failure can hide a successful create response. Never issue
      // another create call without human reconciliation: that could duplicate
      // the post. Preflight failures above remain safe to retry automatically.
      slot.instagram_status = "manual_recovery_required";
      slot.retry_count = Number(slot.retry_count || 0) + 1;
      slot.last_error = `Container creation result is uncertain; ${error.message}`;
      slot.last_attempt_at = new Date().toISOString();
      await save(store, key, plan);
      return Response.json({ error: slot.last_error, retry_count: slot.retry_count }, { status: 409 });
    }
  }


  try {
    const status = await containerStatus(slot.instagram_container_id, token);
    if (status === "ERROR" || status === "EXPIRED") throw new Error(`Instagram media container is ${status.toLowerCase()}`);
    if (status !== "FINISHED") {
      slot.instagram_status = "container_processing";
      slot.last_error = null;
      await save(store, key, plan);
      return Response.json({ pending: "Instagram is still processing the validated creative", container_status: status || "unknown" }, { status: 202 });
    }
  } catch (error) {
    slot.instagram_status = "retrying";
    slot.retry_count = Number(slot.retry_count || 0) + 1;
    slot.last_error = error.message;
    slot.last_attempt_at = new Date().toISOString();
    await save(store, key, plan);
    return Response.json({ error: error.message, retry_count: slot.retry_count }, { status: 502 });
  }

  slot.instagram_status = "publishing";
  slot.last_attempt_at = new Date().toISOString();
  await save(store, key, plan);
  try {
    slot.instagram_media_id = await publishContainer(profile.id, slot.instagram_container_id, token);
    slot.instagram_status = "published";
    slot.published_at = new Date().toISOString();
    slot.last_error = null;
    // The repository can verify that the matching LinkDM Draft Code was placed
    // in the caption. LinkDM activation itself remains an external browser/API
    // action unless a documented LinkDM API credential is supplied.
    slot.linkdm_status = slot.linkdm_draft_code ? "draft_code_published_pending_external_verification" : "next_post_published_pending_sync";
    await save(store, key, plan);
    const historyStore = getStore("instagram-deal-history");
    const historyRecord = {
      deal_id: slot.deal_id, product_key: slot.product_key, status: "published",
      plan_date: now.date, hour: now.hour, instagram_media_id: slot.instagram_media_id,
      published_at: slot.published_at,
    };
    await Promise.all([
      historyStore.setJSON(`deal-${encodeURIComponent(slot.deal_id)}`, historyRecord),
      historyStore.setJSON(`product-${encodeURIComponent(slot.product_key || `deal:${slot.deal_id}`)}`, historyRecord),
    ]);
    console.log("[publish-instagram-deal]", JSON.stringify({
      date: now.date, hour: now.hour, dealId: slot.deal_id, mediaId: slot.instagram_media_id,
      containerId: slot.instagram_container_id,
    }));
    return Response.json({ ok: true, date: now.date, hour: now.hour, deal_id: slot.deal_id, instagram_media_id: slot.instagram_media_id });
  } catch (error) {
    // Preserve the existing container ID so a retry cannot create duplicate
    // media. The same frozen deal and caption will be retried.
    slot.instagram_status = "retrying";
    slot.retry_count = Number(slot.retry_count || 0) + 1;
    slot.last_error = error.message;
    slot.last_attempt_at = new Date().toISOString();
    await save(store, key, plan);
    return Response.json({ error: error.message, retry_count: slot.retry_count }, { status: 502 });
  }
}

export const config = { schedule: "*/5 * * * *" };
