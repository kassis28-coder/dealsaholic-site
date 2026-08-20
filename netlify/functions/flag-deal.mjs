import { getStore } from "@netlify/blobs";

function flagReasonFor(issueType) {
  if (issueType === "missing-price") return "missing-price";
  if (issueType === "missing-image") return "missing-image";
  if (issueType === "missing-price-image") return "missing-price-and-image";
  return "expired-code-reported-by-shopper";
}

async function flagSubmission(dealId, flagReason) {
  const store = getStore("submissions");
  const record = await store.get(dealId, { type: "json" }).catch(() => null);
  if (!record) return false;

  record.status = "needs-review";
  record.flaggedAt = new Date().toISOString();
  record.flagReason = flagReason;
  await store.setJSON(dealId, record);
  return true;
}

async function flagAmazonDeal(dealId, flagReason, issueType, code, productUrl) {
  const store = getStore("deals");
  const data = await store.get("latest", { type: "json" }).catch(() => null);
  const deals = Array.isArray(data?.deals) ? data.deals : [];
  const normalizedId = String(dealId || "").toUpperCase();
  const index = deals.findIndex((deal) =>
    String(deal.id || "").toUpperCase() === normalizedId
      || String(deal.asin || "").toUpperCase() === normalizedId
  );

  if (index >= 0) {
    deals[index].needsReview = true;
    deals[index].flaggedAt = new Date().toISOString();
    deals[index].flagReason = flagReason;
    deals[index].flagIssueType = issueType;
    await store.setJSON("latest", { ...data, deals });

    // Remove the cached public feed so the reported deal is hidden promptly.
    await getStore("public-deals-cache").delete("latest-deduped-v2").catch(() => {});
    return true;
  }

  // Preserve a report even when the Amazon refresh replaced the deal between
  // page load and the shopper clicking the report button.
  await getStore("flagged-deals").setJSON(`flag-${dealId}`, {
    dealId,
    asin: /^[A-Z0-9]{10}$/i.test(String(dealId || "")) ? String(dealId).toUpperCase() : null,
    code: code || null,
    productUrl,
    url: productUrl,
    issueType,
    flaggedAt: new Date().toISOString(),
    flagReason,
    status: "needs-review",
  });
  return true;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const {
      dealId,
      dealSource,
      code,
      productUrl,
      issueType = "expired-code",
    } = await req.json();

    if (!dealId || !productUrl) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
    }
    if (issueType === "expired-code" && !code) {
      return new Response(JSON.stringify({ error: "Missing promo code" }), { status: 400 });
    }

    // A shopper report must always reach the admin queue. Scraping the Amazon
    // page here produced false "still valid" results because codes can remain
    // in page scripts after they stop applying at checkout.
    const flagReason = flagReasonFor(issueType);
    const saved = dealSource === "submission"
      ? await flagSubmission(dealId, flagReason)
      : await flagAmazonDeal(dealId, flagReason, issueType, code, productUrl);

    if (!saved) {
      return new Response(JSON.stringify({ error: "Deal not found" }), { status: 404 });
    }

    return new Response(JSON.stringify({ ok: true, action: "flagged", reason: flagReason }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("flag-deal error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const config = { path: "/api/flag-deal" };
