import assert from "node:assert/strict";
import test from "node:test";
import { isJoyLinkRateLimit, joyLinkRetryDelayMs } from "../netlify/functions/lib/joylink-rate-limit.mjs";

test("recognizes JoyLink rate limits and honors Retry-After", () => {
  const response = {
    status: 429,
    headers: { get: (name) => name === "retry-after" ? "12" : null },
  };

  assert.equal(isJoyLinkRateLimit(response, {}), true);
  assert.equal(joyLinkRetryDelayMs(response, {}), 12_000);
});

test("extracts reset seconds from JoyLink's error message", () => {
  const response = { status: 400, headers: { get: () => null } };
  const data = { error: "Rate limit exceeded. Maximum 60 requests per minute. Resets in 9s." };

  assert.equal(isJoyLinkRateLimit(response, data), true);
  assert.equal(joyLinkRetryDelayMs(response, data), 9_000);
});
