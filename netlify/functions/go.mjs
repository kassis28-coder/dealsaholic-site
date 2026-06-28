export default async (req) => {
  const url = new URL(req.url);
  const asin = url.searchParams.get('asin');
  const dest = url.searchParams.get('url');

  let redirectUrl;
  if (asin) {
    redirectUrl = `https://www.amazon.com/dp/${asin}?tag=kethya08-20&linkCode=ll1&language=en_US`;
  } else if (dest) {
    redirectUrl = decodeURIComponent(dest);
  } else {
    return new Response('Not found', { status: 404 });
  }

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Redirecting...</title>
<script>
  window.location.replace("${redirectUrl}");
</script>
</head>
<body>
<p>Taking you to the deal... <a href="${redirectUrl}">Click here if not redirected</a></p>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    }
  });
};

export const config = { path: '/go' };
