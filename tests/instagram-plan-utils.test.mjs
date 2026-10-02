import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import {
  SLOT_HOURS,
  addEasternDays,
  buildCaption,
  easternNow,
  isUsableDeal,
  nextInstagramAction,
  publicSlot,
  slotSnapshot,
} from "../netlify/functions/instagram-plan-utils.mjs";

test("represents exactly the six required ET slots", () => {
  assert.deepEqual(SLOT_HOURS, ["07", "10", "13", "16", "19", "22"]);
});

test("keeps ET date arithmetic stable across daylight saving boundaries", () => {
  assert.equal(easternNow(new Date("2026-03-08T12:00:00Z")).date, "2026-03-08");
  assert.equal(addEasternDays("2026-03-08", 1), "2026-03-09");
  assert.equal(addEasternDays("2026-11-01", 1), "2026-11-02");
});

test("rejects malformed, review-needed, image-less and price-less deals", () => {
  const valid = { id: "B0TEST123", title: "Verified Product Title", image: "https://m.media-amazon.com/images/I/example.jpg", price: "$19.99" };
  assert.equal(isUsableDeal(valid), true);
  assert.equal(isUsableDeal({ ...valid, needsReview: true }), false);
  assert.equal(isUsableDeal({ ...valid, title: "<html>broken</html>" }), false);
  assert.equal(isUsableDeal({ ...valid, image: "https://example.invalid/image.jpg" }), false);
  assert.equal(isUsableDeal({ ...valid, price: "N/A" }), false);
});

test("freezes one exact deal and uses matching data in image URL and caption", () => {
  const deal = {
    id: "B0TEST123", title: "Exact Product Name", image: "https://m.media-amazon.com/images/I/example.jpg",
    price: "$19.99", originalPrice: "$29.99", promoCode: "SAVE10",
  };
  const slot = slotSnapshot(deal, "10", "2026-09-29T10:00:00[America/New_York]");
  assert.match(slot.caption, /Exact Product Name/);
  assert.match(slot.caption, /https:\/\/deals-aholic\.com\/d\/B0TEST123/);
  assert.match(slot.caption, /Comment LINK and I’ll send you the exact deal in your DMs/);
  slot.linkdm_draft_code = "DRAFT-CODE-123";
  slot.linkdm_status = "ready";
  assert.equal(slot.deal_url, "https://deals-aholic.com/d/B0TEST123");
  assert.equal(slot.social_image_url, "https://deals-aholic.com/api/instagram-social-card?date=2026-09-29&hour=10");
  const caption = buildCaption(slot);
  assert.match(caption, /Exact Product Name/);
  assert.match(caption, /\$19\.99 \(was \$29\.99\)/);
  assert.match(caption, /Promo code: SAVE10/);
  assert.match(caption, /https:\/\/deals-aholic\.com\/d\/B0TEST123/);
  assert.match(caption, /Comment LINK and I’ll send you the exact deal in your DMs 💌/);
  assert.match(caption, /DRAFT-CODE-123$/);
});

test("retries only the saved Instagram container and never creates a duplicate", () => {
  const slot = {
    linkdm_draft_code: "DRAFT-1", linkdm_status: "ready", instagram_status: "planned",
    creative_key: "2026-09-29/07-test.jpg", creative_status: "validated", creative_width: 1080, creative_height: 1350,
    creative_style_version: "luxury-lifestyle-editorial-v1",
  };
  assert.equal(nextInstagramAction(slot), "create_container");
  slot.instagram_container_id = "container-123";
  slot.instagram_status = "retrying";
  assert.equal(nextInstagramAction(slot), "publish_container");
  slot.instagram_media_id = "media-123";
  slot.instagram_status = "published";
  assert.equal(nextInstagramAction(slot), "done");
  delete slot.instagram_container_id;
  delete slot.instagram_media_id;
  slot.instagram_status = "creating_container";
  assert.equal(nextInstagramAction(slot), "manual_recovery_required");
});

test("blocks publication unless the creative was generated and validated at 1080x1350", () => {
  const slot = { instagram_status: "planned" };
  assert.equal(nextInstagramAction(slot), "blocked_creative");
  Object.assign(slot, { creative_key: "creative.jpg", creative_status: "validated", creative_width: 1080, creative_height: 1080 });
  assert.equal(nextInstagramAction(slot), "blocked_creative");
  slot.creative_height = 1350;
  slot.creative_style_version = "luxury-lifestyle-editorial-v1";
  assert.equal(nextInstagramAction(slot), "create_container");
});

test("diagnostic output never exposes LinkDM draft codes or caption content", () => {
  const slot = {
    hour: "07", title: "Private deal", caption: "contains private DRAFT-99", linkdm_draft_code: "DRAFT-99",
    linkdm_status: "ready", instagram_status: "planned", social_image_url: "https://deals-aholic.com/image.jpg",
  };
  const result = publicSlot(slot);
  assert.equal(result.linkdm_draft_ready, true);
  assert.equal("linkdm_draft_code" in result, false);
  assert.equal("caption" in result, false);
});

test("new slots wait for the persistent LinkDM next-post synchronization", () => {
  const slot = slotSnapshot({
    id: "B0LINKDM", title: "Approved LinkDM Test Deal", image: "https://m.media-amazon.com/images/I/example.jpg", price: "$12.99",
  }, "07", "2026-10-02T07:00:00[America/New_York]");
  assert.equal(slot.linkdm_status, "awaiting_next_post_sync");
});

test("Instagram implementation is frozen-slot only and treats LinkDM as optional", async () => {
  const [publish, card] = await Promise.all([
    fs.readFile(new URL("../netlify/functions/publish-instagram-deals.mjs", import.meta.url), "utf8"),
    fs.readFile(new URL("../netlify/functions/instagram-social-card.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(publish, /LinkDM is optional/);
  assert.match(publish, /instagram_container_id/);
  assert.match(publish, /refusing to create duplicate Instagram media/);
  assert.doesNotMatch(publish, /facebook\.com|FACEBOOK_|page_id/i);
  assert.match(card, /generated and validated during planning/);
  assert.match(card, /instagram-creatives/);
  assert.doesNotMatch(card, /getStore\("deals"\)/);
  const queue = await fs.readFile(new URL("../netlify/functions/queue-instagram-creative.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(queue, /facebook\.com|FACEBOOK_|page_id/i);
  assert.match(queue, /1080x1350/);
});
