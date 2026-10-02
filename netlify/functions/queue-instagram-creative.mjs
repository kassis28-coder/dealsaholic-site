import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";
import sharp from "sharp";
import { dealId, isUsableDeal } from "./instagram-plan-utils.mjs";

const QUEUE_STORE = "instagram-approved-creative-queue";
const INDEX_KEY = "approved-index";

function authorized(req) {
  const expected = String(process.env.SOCIAL_AUTOMATION_SECRET || "");
  const supplied = String(req.headers.get("x-social-automation-secret") || "");
  if (!expected || !supplied || expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

export default async function handler(req) {
  if (req.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const requestedDealId = String(form.get("dealId") || "").trim();
  const image = form.get("image");
  const styleApproved = String(form.get("styleApproved") || "").toLowerCase() === "true";
  if (!requestedDealId || !image || typeof image.arrayBuffer !== "function") {
    return Response.json({ error: "dealId and image are required" }, { status: 400 });
  }
  if (!styleApproved) {
    return Response.json({ error: "The locked Deals-Aholic editorial style must be explicitly approved" }, { status: 400 });
  }

  const latest = await getStore("deals").get("latest", { type: "json" }).catch(() => null);
  const deal = (Array.isArray(latest?.deals) ? latest.deals : []).find((item) => dealId(item) === requestedDealId);
  if (!deal || !isUsableDeal(deal)) return Response.json({ error: "A matching usable deal was not found" }, { status: 404 });

  const source = Buffer.from(await image.arrayBuffer());
  if (source.length < 25_000 || source.length > 12 * 1024 * 1024) {
    return Response.json({ error: "Creative file size is invalid" }, { status: 400 });
  }
  let jpeg;
  try {
    const metadata = await sharp(source, { failOn: "error" }).metadata();
    if (metadata.width !== 1080 || metadata.height !== 1350) throw new Error("Creative must be exactly 1080x1350");
    jpeg = await sharp(source).rotate().jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).toBuffer();
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }

  const sha256 = crypto.createHash("sha256").update(jpeg).digest("hex");
  const store = getStore(QUEUE_STORE);
  const blobKey = `creative-${encodeURIComponent(requestedDealId)}-${sha256.slice(0, 16)}.jpg`;
  await store.set(blobKey, jpeg, { metadata: { contentType: "image/jpeg", width: 1080, height: 1350, sha256 } });

  const index = await store.get(INDEX_KEY, { type: "json" }).catch(() => null);
  const items = Array.isArray(index?.items) ? index.items.filter((item) => item.deal_id !== requestedDealId && item.status === "approved") : [];
  items.push({ deal_id: requestedDealId, blob_key: blobKey, sha256, bytes: jpeg.length, status: "approved", approved_at: new Date().toISOString(), style_version: "luxury-lifestyle-editorial-v1" });
  await store.setJSON(INDEX_KEY, { updated_at: new Date().toISOString(), items });
  return Response.json({ ok: true, deal_id: requestedDealId, width: 1080, height: 1350, sha256, status: "approved" });
}

export const config = { path: "/api/queue-instagram-creative" };
