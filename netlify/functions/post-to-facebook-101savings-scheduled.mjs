import { postPendingDeals } from "./post-to-facebook-101savings.mjs";

// One approved, image-backed, non-duplicate deal every ten minutes.
// This caps 101 Savings at six posts per hour without touching the existing
// DealsAholic Facebook scheduler or its state flags.
export default async function handler() {
  try {
    // Scan the approved deals already published through the site collection.
    // This deliberately does not use the small deals/latest import batch.
    const result = await postPendingDeals(1);
    console.log("[101-savings-scheduled]", JSON.stringify(result));
  } catch (err) {
    console.error("[101-savings-scheduled] Failed:", err.message);
    throw err;
  }
}

export const config = {
  schedule: "*/10 * * * *",
};
