export const SITE_URL = "https://deals-aholic.com";
export const TIME_ZONE = "America/New_York";
export const SLOT_HOURS = ["07", "10", "13", "16", "19", "22"];
export const RETRY_WINDOW_MINUTES = 55;

const IMAGE_HOSTS = [
  /(^|\.)amazon\.com$/i,
  /(^|\.)amazonaws\.com$/i,
  /(^|\.)media-amazon\.com$/i,
  /(^|\.)ssl-images-amazon\.com$/i,
  /(^|\.)walmart\.com$/i,
  /(^|\.)walmartimages\.com$/i,
  /^deals-aholic\.com$/i,
];

export function easternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function easternNow(date = new Date()) {
  const parts = easternParts(date);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour,
    minute: Number(parts.minute),
  };
}

export function addEasternDays(dateKey, days) {
  const [year, month, day] = dateKey.split("-").map(Number);
  // 17:00 UTC is safely inside the ET calendar day around DST changes.
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 17, 0, 0));
  const parts = easternParts(shifted);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function dealId(deal) {
  return String(deal?.id || deal?.asin || "").trim();
}

export function validImageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && IMAGE_HOSTS.some((pattern) => pattern.test(url.hostname));
  } catch {
    return false;
  }
}

export function validPrice(value) {
  const numeric = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(numeric) && numeric > 0;
}

export function isUsableDeal(deal) {
  const title = String(deal?.title || "").trim();
  const image = String(deal?.image || deal?.imageUrl || "").trim();
  const id = dealId(deal);
  return Boolean(
    !deal?.needsReview &&
    id &&
    title.length >= 8 &&
    title.length <= 500 &&
    !/<[^>]+>/i.test(title) &&
    validImageUrl(image) &&
    validPrice(deal?.price)
  );
}

export function dealTimestamp(deal) {
  const value = new Date(deal?.createdAt || deal?.fetchedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function canonicalDealUrl(deal) {
  const id = dealId(deal);
  if (!id) throw new Error("Deal cannot be uniquely identified");
  return `${SITE_URL}/d/${encodeURIComponent(id)}`;
}

export function slotSnapshot(deal, hour, scheduledAt) {
  const id = dealId(deal);
  const promo = String(deal.promoCode || deal.discountCode || deal.code || "").trim() || null;
  const slot = {
    hour,
    scheduled_at: scheduledAt,
    deal_id: id,
    title: String(deal.title).trim(),
    source_image_url: String(deal.image || deal.imageUrl),
    approved_editorial_image_url: String(deal.approvedInstagramImageUrl || deal.instagramEditorialImageUrl || "") || null,
    editorial_style_approved: deal.instagramCreativeApproved === true,
    price: String(deal.price),
    original_price: deal.originalPrice ? String(deal.originalPrice) : null,
    promo_code: promo,
    deal_url: canonicalDealUrl(deal),
    social_image_url: `${SITE_URL}/api/social-card?date=${encodeURIComponent(scheduledAt.slice(0, 10))}&hour=${hour}`,
    creative_key: null,
    creative_status: "pending_generation",
    creative_width: null,
    creative_height: null,
    creative_bytes: null,
    creative_sha256: null,
    creative_style_version: null,
    caption: null,
    linkdm_draft_code: null,
    linkdm_status: "awaiting_next_post_sync",
    instagram_container_id: null,
    instagram_media_id: null,
    instagram_status: "planned",
    retry_count: 0,
    last_error: null,
    last_attempt_at: null,
    published_at: null,
  };
  // Keep the immutable deal copy in storage from planning time. When the
  // LinkDM code is supplied it is appended to this exact frozen caption.
  slot.caption = buildCaption(slot);
  return slot;
}

export function buildCaption(slot) {
  const linkDmReady = Boolean(slot.linkdm_draft_code && slot.linkdm_status === "ready");
  const linkDmNextPost = ["awaiting_next_post_sync", "next_post_published_pending_sync"].includes(slot.linkdm_status);
  const linkDmEnabled = linkDmReady || linkDmNextPost;
  const lines = [
    "🔥 Deal drop!",
    "",
    slot.title,
    slot.price ? `💰 ${slot.price}${slot.original_price ? ` (was ${slot.original_price})` : ""}` : "",
    slot.promo_code ? `🏷️ Promo code: ${slot.promo_code}` : "",
    "",
    linkDmEnabled ? "Comment LINK and I’ll send you the exact deal in your DMs 💌" : "Shop this deal at deals-aholic.com ✨",
    "",
    slot.deal_url,
    "",
    "Follow @deals_aholic for more daily finds, price drops, and promo codes.",
    "",
    "#ad As an Amazon Associate, Deals-Aholic may earn from qualifying purchases.",
    "#DealsAholic #AmazonFinds #DealAlert #ShoppingDeals #Sale",
    "",
    linkDmReady ? slot.linkdm_draft_code : "",
  ];
  return lines.filter(Boolean).join("\n").slice(0, 2100);
}

// This small state decision is deliberately pure so the publisher can be
// tested without calling Instagram. In particular, a stored container can be
// published on retry, but a new container is never created for the same slot.
export function nextInstagramAction(slot) {
  if (slot?.instagram_status === "published" && slot?.instagram_media_id) return "done";
  if (slot?.creative_status !== "validated" || !slot?.creative_key || slot?.creative_width !== 1080 || slot?.creative_height !== 1350 || slot?.creative_style_version !== "luxury-lifestyle-editorial-v1") return "blocked_creative";
  if (slot?.instagram_container_id) return "publish_container";
  if (slot?.instagram_status === "creating_container") return "manual_recovery_required";
  return "create_container";
}

export function publicSlot(slot) {
  return {
    hour: slot.hour,
    scheduled_at: slot.scheduled_at,
    deal_id: slot.deal_id,
    title: slot.title,
    source_image_url: slot.source_image_url,
    price: slot.price,
    original_price: slot.original_price,
    promo_code: slot.promo_code,
    deal_url: slot.deal_url,
    social_image_url: slot.social_image_url,
    creative_status: slot.creative_status,
    creative_width: slot.creative_width,
    creative_height: slot.creative_height,
    creative_bytes: slot.creative_bytes,
    creative_sha256: slot.creative_sha256,
    creative_style_version: slot.creative_style_version,
    linkdm_draft_ready: Boolean(slot.linkdm_draft_code),
    linkdm_status: slot.linkdm_status,
    instagram_container_id: slot.instagram_container_id,
    instagram_media_id: slot.instagram_media_id,
    instagram_status: slot.instagram_status,
    retry_count: Number(slot.retry_count || 0),
    last_error: slot.last_error || null,
    published_at: slot.published_at || null,
  };
}
