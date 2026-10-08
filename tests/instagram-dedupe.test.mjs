import assert from "node:assert/strict";
import test from "node:test";
import { dealIdsFromCaption, fetchPublishedInstagramDealIds } from "../netlify/functions/instagram-dedupe.mjs";

test("extracts exact Deals-Aholic deal IDs from Instagram captions", () => {
  assert.deepEqual([...dealIdsFromCaption("Shop https://deals-aholic.com/d/sub_123_abc?utm=x and save")], ["sub_123_abc"]);
  assert.equal(dealIdsFromCaption("https://amazon.com/dp/B0TEST").size, 0);
});

test("collects published deal IDs across Instagram media pages", async () => {
  const responses = [
    { data: [{ caption: "https://deals-aholic.com/d/deal-one" }], paging: { next: "https://next.test/page" } },
    { data: [{ caption: "Again https://deals-aholic.com/d/deal-two" }] },
  ];
  const ids = await fetchPublishedInstagramDealIds("token", {
    fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual([...ids], ["deal-one", "deal-two"]);
});

test("fails closed when Instagram duplicate history cannot be read", async () => {
  await assert.rejects(() => fetchPublishedInstagramDealIds("token", {
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "token expired" } }), { status: 401 }),
  }), /token expired/);
});
