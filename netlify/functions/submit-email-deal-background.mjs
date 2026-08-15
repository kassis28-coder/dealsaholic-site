import submitEmailDeal from './submit-email-deal.mjs';

// Netlify treats functions whose name ends in "-background" as background
// functions. The caller receives HTTP 202 immediately, while the existing
// parser continues with Netlify's longer background-function time limit.
export default async function handler(request, context) {
  const response = await submitEmailDeal(request, context);

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`Email deal parser failed (${response.status}): ${details}`);
  }

  console.log(`[submit-email-deal-background] Completed with HTTP ${response.status}`);
}

export const config = { path: '/api/submit-email-deal-background' };
