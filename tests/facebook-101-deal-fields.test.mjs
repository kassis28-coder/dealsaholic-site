import assert from "node:assert/strict";
import test from "node:test";
import { resolve101SavingsDeal } from "../netlify/functions/lib/facebook-101-deal-fields.mjs";

test("normalizes email-imported website deal fields for 101 Savings", () => {
  const deal = resolve101SavingsDeal({
    productTitle: "Website deal",
    productUrl: "https://example.com/deal",
    imageUrl: "https://example.com/deal.jpg",
    currentPrice: "$9.99",
    wasPrice: "$19.99",
    discountPercent: 50,
    discountCode: "SAVE50",
  });

  assert.equal(deal.title, "Website deal");
  assert.equal(deal.url, "https://example.com/deal");
  assert.equal(deal.image, "https://example.com/deal.jpg");
  assert.equal(deal.price, "$9.99");
  assert.equal(deal.originalPrice, "$19.99");
  assert.equal(deal.discount, 50);
  assert.equal(deal.promoCode, "SAVE50");
});
