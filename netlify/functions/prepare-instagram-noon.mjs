import { prepareInstagramBatch } from "./prepare-instagram-day.mjs";

// Netlify cron is UTC; poll briefly and gate in the shared handler against the
// America/New_York wall clock so the noon run follows daylight-saving time.
export default function handler(req) {
  return prepareInstagramBatch(req, { batch: "noon" });
}

export const config = { schedule: "*/5 * * * *" };
