export default async (req) => {
  const url = new URL(req.url);
  const asin = url.searchParams.get('asin');
  const dest = url.searchParams.get('url');

  let redirectUrl;

  if (asin) {
  redirectUrl = `https://smile.amazon.com/dp/${asin}?tag=kethya08-20&linkCode=ll1&language=en_US`;
  } else if (dest) {
    // For non-Amazon links (Walmart, etc)
    redirectUrl = decodeURIComponent(dest);
  } else {
    return new Response('Not found', { status: 404 });
  }

  return new Response(null, {
    status: 302,
    headers: {
      'Location': redirectUrl,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    }
  });
};

export const config = { path: '/go' };
