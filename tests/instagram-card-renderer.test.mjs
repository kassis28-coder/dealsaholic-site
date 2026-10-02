import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  INSTAGRAM_CARD_HEIGHT,
  INSTAGRAM_CARD_WIDTH,
  SQUARE_SAFE_BOTTOM,
  SQUARE_SAFE_TOP,
  renderInstagramCard,
} from "../netlify/functions/instagram-card-renderer.mjs";

const productFixture = Buffer.from(`
  <svg width="900" height="700" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="700" fill="#fff"/>
    <path d="M330 90h240l80 100-90 75-30-45v390H370V220l-30 45-90-75z" fill="#c7ad98" stroke="#6e5142" stroke-width="10"/>
    <path d="M400 90q50 70 100 0" fill="none" stroke="#6e5142" stroke-width="10"/>
    <text x="450" y="660" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#6e5142">TEST PRODUCT</text>
    <!-- ${"fixture-padding-".repeat(80)} -->
  </svg>
`);

test("renders a validated 1080x1350 luxury card with a centered square safe area", async () => {
  const deal = {
    deal_id: "TEST-LAYOUT-ONLY",
    title: "Layout Validation Product",
    source_image_url: "https://m.media-amazon.com/images/I/test-product.jpg",
    price: "$19.99",
    original_price: "$39.99",
    promo_code: "TESTONLY",
    deal_url: "https://deals-aholic.com/d/TEST-LAYOUT-ONLY",
  };
  const result = await renderInstagramCard(deal, {
    fetchImpl: async () => new Response(productFixture, { status: 200, headers: { "content-type": "image/svg+xml" } }),
  });
  const metadata = await sharp(result.buffer).metadata();
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1350);
  assert.equal(result.width, INSTAGRAM_CARD_WIDTH);
  assert.equal(result.height, INSTAGRAM_CARD_HEIGHT);
  assert.equal(SQUARE_SAFE_TOP, 135);
  assert.equal(SQUARE_SAFE_BOTTOM, 1215);
  assert.equal(result.sha256.length, 64);
  assert.ok(result.bytes > 25_000);
  assert.equal(result.styleApproved, false);
  assert.equal(result.styleVersion, "technical-safe-area-preview");
});

test("accepts a separately approved exact-size editorial creative", async () => {
  const approved = await sharp({
    create: { width: 1080, height: 1350, channels: 3, background: "#eaded2" },
  }).jpeg({ quality: 94 }).toBuffer();
  const result = await renderInstagramCard({
    deal_id: "APPROVED-1", title: "Approved Editorial Product",
    source_image_url: "https://m.media-amazon.com/images/I/product.jpg",
    price: "$24.99", deal_url: "https://deals-aholic.com/d/APPROVED-1",
  }, { approvedBuffer: approved });
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1350);
  assert.equal(result.styleApproved, true);
  assert.equal(result.styleVersion, "luxury-lifestyle-editorial-v1");
});
