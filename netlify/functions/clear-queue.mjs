import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const password = url.searchParams.get('password');
  
  if (password !== process.env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const queueStore = getStore("deal-queue");
  await queueStore.setJSON('queue', []);

  return new Response(JSON.stringify({ success: true, message: 'Queue cleared' }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { path: '/api/clear-queue' };
