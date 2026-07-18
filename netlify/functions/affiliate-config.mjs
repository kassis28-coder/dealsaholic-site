// Single source of truth for the Amazon affiliate tag.
// All functions and pages must read from process.env.AMAZON_PARTNER_TAG.
// This endpoint exposes it safely to browser-side code (deal.html).
export default async () => {
  return new Response(
    JSON.stringify({ partnerTag: process.env.AMAZON_PARTNER_TAG || '' }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
      },
    }
  );
};

export const config = { path: '/api/affiliate-config' };
