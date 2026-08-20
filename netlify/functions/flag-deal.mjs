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

async function flagAmazonDeal(
  dealId,
  flagReason,
  issueType,
  code,
  productUrl
) {
  const store = getStore("deals");

  const data = await store
    .get("latest", { type: "json" })
    .catch(() => null);

  const deals = Array.isArray(data?.deals)
    ? data.deals
    : [];

  const normalizedId = String(dealId || "").toUpperCase();

  const index = deals.findIndex((deal) =>
    String(deal.id || "").toUpperCase() === normalizedId ||
    String(deal.asin || "").toUpperCase() === normalizedId
  );

  const flaggedAt = new Date().toISOString();
  const matchingDeal = index >= 0 ? deals[index] : null;

  /*
   * Flag the current Amazon record so it disappears
   * from the public feed immediately.
   */
  if (index >= 0) {
    deals[index].needsReview = true;
    deals[index].flaggedAt = flaggedAt;
    deals[index].flagReason = flagReason;
    deals[index].flagIssueType = issueType;

    await store.setJSON("latest", {
      ...data,
      deals,
    });
  }

  /*
   * IMPORTANT:
   * Always create a permanent review record.
   *
   * Amazon refreshes replace the deals/latest feed.
   * Without this separate record, the expired report
   * can disappear from Admin > Needs Review.
   */
  const durableId =
    matchingDeal?.asin ||
    matchingDeal?.id ||
    dealId;

  const flagStore = getStore("flagged-deals");

  await flagStore.setJSON(
    `flag-${String(durableId)}`,
    {
      dealId: durableId,

      asin:
        matchingDeal?.asin ||
        (/^[A-Z0-9]{10}$/i.test(String(dealId || ""))
          ? String(dealId).toUpperCase()
          : null),

      title: matchingDeal?.title || null,
      image: matchingDeal?.image || null,

      price: matchingDeal?.price || null,
      originalPrice:
        matchingDeal?.originalPrice || null,

      discountPercent:
        matchingDeal?.discountPercent || null,

      code:
        code ||
        matchingDeal?.discountCode ||
        null,

      productUrl:
        productUrl ||
        matchingDeal?.url ||
        null,

      url:
        productUrl ||
        matchingDeal?.url ||
        null,

      issueType,
      flaggedAt,
      flagReason,
      status: "needs-review",
    }
  );

  /*
   * Delete the cached public feed so the reported
   * deal is removed on the next request.
   */
  await getStore("public-deals-cache")
    .delete("latest-deduped-v3")
    .catch(() => {});

  return true;
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({
        error: "Method not allowed",
      }),
      {
        status: 405,
      }
    );
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
      return new Response(
        JSON.stringify({
          error: "Missing required fields",
        }),
        {
          status: 400,
        }
      );
    }

    if (
      issueType === "expired-code" &&
      !code
    ) {
      return new Response(
        JSON.stringify({
          error: "Missing promo code",
        }),
        {
          status: 400,
        }
      );
    }

    /*
     * Do NOT ask Amazon whether the code is still
     * visible on the product page.
     *
     * A coupon code can still appear in Amazon page
     * data even when it no longer works at checkout.
     *
     * A shopper report should therefore always go
     * to Admin > Needs Review.
     */
    const flagReason =
      flagReasonFor(issueType);

    const saved =
      dealSource === "submission"
        ? await flagSubmission(
            dealId,
            flagReason
          )
        : await flagAmazonDeal(
            dealId,
            flagReason,
            issueType,
            code,
            productUrl
          );

    if (!saved) {
      return new Response(
        JSON.stringify({
          error: "Deal not found",
        }),
        {
          status: 404,
        }
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        action: "flagged",
        reason: flagReason,
      }),
      {
        status: 200,
        headers: {
          "Content-Type":
            "application/json",
        },
      }
    );
  } catch (err) {
    console.error(
      "flag-deal error:",
      err.message
    );

    return new Response(
      JSON.stringify({
        error: err.message,
      }),
      {
        status: 500,
      }
    );
  }
};

export const config = {
  path: "/api/flag-deal",
};
