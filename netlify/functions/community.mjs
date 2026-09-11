import { getStore } from "@netlify/blobs";

const REACTIONS = new Set(["👍", "❤️", "😂", "😮", "😢", "👎"]);
const MAX_COMMENTS = 200;
const MAX_COMMENT_LENGTH = 500;
const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers });
}

function cleanText(value, max = MAX_COMMENT_LENGTH) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function cleanId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 160);
}

function cleanProfile(profile) {
  const id = cleanId(profile?.id);
  const name = cleanText(profile?.name, 30);
  if (!id || !name) return null;
  return { id, name, type: profile?.type === "member" ? "member" : "guest" };
}

function keyForDeal(dealId) {
  return `deal-${encodeURIComponent(cleanId(dealId))}`;
}

function emptyCommunity(dealId) {
  return { dealId, reactions: {}, comments: [], updatedAt: new Date().toISOString() };
}

function publicCommunity(record) {
  const counts = {};
  for (const reaction of Object.values(record.reactions || {})) {
    if (REACTIONS.has(reaction)) counts[reaction] = (counts[reaction] || 0) + 1;
  }
  return {
    reactionCounts: counts,
    comments: (record.comments || [])
      .filter((comment) => comment.status === "visible")
      .map(({ id, parentId, author, text, createdAt }) => ({ id, parentId, author, text, createdAt })),
  };
}

async function loadCommunity(store, dealId) {
  return await store.get(keyForDeal(dealId), { type: "json" }).catch(() => null) || emptyCommunity(dealId);
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  const url = new URL(req.url);
  const dealId = cleanId(url.searchParams.get("dealId"));
  if (!dealId) return response({ error: "A deal ID is required." }, 400);

  const store = getStore("deal-community");
  if (req.method === "GET") {
    const record = await loadCommunity(store, dealId);
    return response(publicCommunity(record));
  }
  if (req.method !== "POST") return response({ error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    const profile = cleanProfile(body.profile);
    if (!profile) return response({ error: "Join the community before posting." }, 401);
    const record = await loadCommunity(store, dealId);

    if (body.action === "reaction") {
      const reaction = String(body.reaction || "");
      if (!REACTIONS.has(reaction)) return response({ error: "Unsupported reaction." }, 400);
      if (record.reactions?.[profile.id] === reaction) delete record.reactions[profile.id];
      else record.reactions = { ...(record.reactions || {}), [profile.id]: reaction };
    } else if (body.action === "comment") {
      if (body.acceptedGuidelines !== true) return response({ error: "You must accept the community guidelines before posting." }, 400);
      const text = cleanText(body.text);
      const parentId = body.parentId ? cleanId(body.parentId) : null;
      if (text.length < 2) return response({ error: "Write a longer comment." }, 400);
      if (parentId && !record.comments.some((comment) => comment.id === parentId && !comment.parentId)) {
        return response({ error: "The comment you are replying to is unavailable." }, 404);
      }
      const now = new Date().toISOString();
      const recent = record.comments.filter((comment) => comment.author?.id === profile.id && Date.now() - new Date(comment.createdAt).getTime() < 10 * 60 * 1000);
      if (recent.length >= 8) return response({ error: "Please wait a few minutes before adding more comments." }, 429);
      record.comments.push({
        id: `comment-${crypto.randomUUID()}`,
        parentId,
        author: profile,
        text,
        createdAt: now,
        status: "visible",
      });
      record.comments = record.comments.slice(-MAX_COMMENTS);
    } else if (body.action === "report") {
      const commentId = cleanId(body.commentId);
      const comment = record.comments.find((entry) => entry.id === commentId);
      if (!comment) return response({ error: "Comment not found." }, 404);
      // Hide reports immediately and keep a separate moderation record for the admin.
      comment.status = "pending-review";
      const reportStore = getStore("community-reports");
      await reportStore.setJSON(`report-${crypto.randomUUID()}`, {
        type: "comment", dealId, commentId, reporter: profile, reason: cleanText(body.reason, 120) || "Reported by a community member", createdAt: new Date().toISOString(), status: "pending-review",
      });
    } else {
      return response({ error: "Unknown community action." }, 400);
    }

    record.updatedAt = new Date().toISOString();
    await store.setJSON(keyForDeal(dealId), record);
    return response(publicCommunity(record));
  } catch (error) {
    console.error("community error", error);
    return response({ error: "Community activity could not be saved." }, 500);
  }
};

export const config = { path: "/api/community" };
