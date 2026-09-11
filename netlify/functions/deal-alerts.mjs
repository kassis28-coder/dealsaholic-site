import { getStore } from "@netlify/blobs";

const headers = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const clean = (value, max) => String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const profileId = (value) => String(value || "").replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160);

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers });
  try {
    const body = await req.json();
    const id = profileId(body.profile?.id);
    const name = clean(body.profile?.name, 30);
    if (!id || !name) return new Response(JSON.stringify({ error: "Join the community before enabling alerts." }), { status: 401, headers });
    const store = getStore("deal-alerts");
    const key = `alert-${id}`;
    if (body.action === "disable") { await store.delete(key).catch(() => undefined); return new Response(JSON.stringify({ ok: true, enabled: false }), { headers }); }
    const token = clean(body.token, 300);
    const keywords = [...new Set((Array.isArray(body.keywords) ? body.keywords : []).map((item) => clean(item, 40).toLowerCase()).filter(Boolean))].slice(0, 10);
    const categories = [...new Set((Array.isArray(body.categories) ? body.categories : []).map((item) => clean(item, 30).toLowerCase()).filter(Boolean))].slice(0, 12);
    if (!token.startsWith("ExponentPushToken[") && !token.startsWith("ExpoPushToken[")) return new Response(JSON.stringify({ error: "A valid notification token is required." }), { status: 400, headers });
    if (!keywords.length && !categories.length) return new Response(JSON.stringify({ error: "Choose at least one keyword or category." }), { status: 400, headers });
    const current = await store.get(key, { type: "json" }).catch(() => null);
    await store.setJSON(key, { profile: { id, name }, token, keywords, categories, enabled: true, createdAt: current?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), sentDealIds: current?.sentDealIds || [] });
    return new Response(JSON.stringify({ ok: true, enabled: true }), { headers });
  } catch (error) { return new Response(JSON.stringify({ error: error.message || "Alert preferences could not be saved." }), { status: 500, headers }); }
};

export const config = { path: "/api/deal-alerts" };
