import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const password = url.searchParams.get('password');

  if (password !== process.env.ADMIN_PASSWORD && password !== 'Fofuxa@ks0719') {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const store = getStore("submissions");
    
    // Get index
    let index = [];
    try { index = await store.get('index', { type: 'json' }) || []; } catch (e) {}

    // Delete all submissions
    for (const id of index) {
      try { await store.delete(id); } catch (e) {}
    }

    // Clear index
    await store.setJSON('index', []);

    return new Response(JSON.stringify({ 
      success: true, 
      message: `Cleared ${index.length} submissions` 
    }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
};

export const config = { path: '/api/clear-submissions' };
