const AMAZON_IMAGE_HOSTS = new Set([
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
]);

export default async (req) => {
  try {
    const requestUrl = new URL(req.url);
    const source = new URL(requestUrl.searchParams.get('src') || '');

    if (source.protocol !== 'https:' || !AMAZON_IMAGE_HOSTS.has(source.hostname)) {
      return new Response('Invalid image source', { status: 400 });
    }

    const upstream = await fetch(source, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DealsAholicPreview/1.0)',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });

    if (!upstream.ok) {
      return new Response('Image unavailable', { status: 502 });
    }

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      return new Response('Invalid image response', { status: 502 });
    }

    return new Response(await upstream.arrayBuffer(), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Netlify-CDN-Cache-Control': 'public, durable, max-age=86400, stale-while-revalidate=604800',
      },
    });
  } catch {
    return new Response('Invalid image request', { status: 400 });
  }
};
