import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { createFacebookFallbackImage } from "../netlify/functions/lib/facebook-fallback-image.mjs";

test("creates a Facebook-safe JPEG fallback card", async () => {
  const image = await createFacebookFallbackImage(
    "A very long deal title that must wrap safely without inventing a product photo",
    { brand: "101 SAVINGS" },
  );
  const metadata = await sharp(image).metadata();

  assert.equal(metadata.format, "jpeg");
  assert.equal(metadata.width, 1080);
  assert.equal(metadata.height, 1080);
  assert.ok(image.byteLength > 10_000);
});
