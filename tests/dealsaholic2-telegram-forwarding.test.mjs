import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTelegramCaption,
  forwardSuccessfulFacebookPost,
  parseTelegramDestinations,
  retryPendingTelegramForwards,
} from "../netlify/functions/lib/dealsaholic2-telegram-forwarding.mjs";

class MemoryStore {
  constructor() { this.values = new Map(); }
  async get(key, options = {}) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    if (options.type === "json") return JSON.parse(String(value));
    if (options.type === "arrayBuffer") {
      const buffer = Buffer.from(value);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    return value;
  }
  async set(key, value) { this.values.set(key, Buffer.from(value)); }
  async setJSON(key, value) { this.values.set(key, JSON.stringify(value)); }
  async delete(key) { this.values.delete(key); }
  async list({ prefix } = {}) {
    return { blobs: [...this.values.keys()].filter((key) => !prefix || key.startsWith(prefix)).map((key) => ({ key })) };
  }
}

const deal = {
  title: "Test Deal",
  price: "$19.99",
  originalPrice: "$39.99",
  discountPercentage: 50,
  promoCode: "SAVE50",
  affiliateUrl: "https://affiliate.example/deal",
};

test("parses JSON, comma, newline, and fallback destinations without duplicates", () => {
  assert.deepEqual(parseTelegramDestinations('["-1001", "@channel"]', "-1001"), ["-1001", "@channel"]);
  assert.deepEqual(parseTelegramDestinations("-1001,@channel\n-1002", ""), ["-1001", "@channel", "-1002"]);
  assert.deepEqual(parseTelegramDestinations("@private-test", "@existing-live-chat"), ["@private-test"]);
  assert.deepEqual(parseTelegramDestinations("", "@existing-live-chat"), ["@existing-live-chat"]);
});

test("caption contains deal fields and the affiliate URL", () => {
  const caption = buildTelegramCaption(deal);
  assert.match(caption, /Test Deal/);
  assert.match(caption, /\$19\.99/);
  assert.match(caption, /\$39\.99/);
  assert.match(caption, /50% off/);
  assert.match(caption, /SAVE50/);
  assert.match(caption, /https:\/\/affiliate\.example\/deal/);
});

test("forwards the exact PNG bytes and isolates destination failures", async () => {
  const store = new MemoryStore();
  const image = Buffer.from("exact-branded-png");
  const seen = [];
  const fetchImpl = async (_url, options) => {
    const chatId = options.body.get("chat_id");
    const photo = Buffer.from(await options.body.get("photo").arrayBuffer());
    seen.push({ chatId, photo });
    if (chatId === "broken") return new Response(JSON.stringify({ ok: false, description: "blocked" }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), { status: 200 });
  };

  const result = await forwardSuccessfulFacebookPost({
    store,
    facebookPostId: "fb-123",
    dealId: "asin:TEST",
    deal,
    imageBuffer: image,
    botToken: "test-token",
    destinations: ["good", "broken"],
    fetchImpl,
    log: () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((entry) => entry.photo.equals(image)));
  assert.equal(Object.values(result.destinations).find((item) => item.chatId === "good").status, "success");
  assert.equal(Object.values(result.destinations).find((item) => item.chatId === "broken").status, "failed");
});

test("retry sends only failed destinations and completed posts are deduplicated", async () => {
  const store = new MemoryStore();
  const calls = [];
  let brokenNowWorks = false;
  const fetchImpl = async (_url, options) => {
    const chatId = options.body.get("chat_id");
    calls.push(chatId);
    if (chatId === "broken" && !brokenNowWorks) {
      return new Response(JSON.stringify({ ok: false, description: "temporary" }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 456 } }), { status: 200 });
  };

  await forwardSuccessfulFacebookPost({
    store,
    facebookPostId: "fb-456",
    dealId: "asin:RETRY",
    deal,
    imageBuffer: Buffer.from("image"),
    botToken: "test-token",
    destinations: ["good", "broken"],
    fetchImpl,
    log: () => {},
  });
  assert.deepEqual(calls.sort(), ["broken", "good"]);

  calls.length = 0;
  brokenNowWorks = true;
  await retryPendingTelegramForwards({
    store,
    botToken: "test-token",
    destinations: ["good", "broken"],
    fetchImpl,
    log: () => {},
  });
  assert.deepEqual(calls, ["broken"]);

  calls.length = 0;
  const duplicate = await forwardSuccessfulFacebookPost({
    store,
    facebookPostId: "fb-456",
    dealId: "asin:RETRY",
    deal,
    imageBuffer: Buffer.from("image"),
    botToken: "test-token",
    destinations: ["good", "broken"],
    fetchImpl,
    log: () => {},
  });
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(calls, []);
});
