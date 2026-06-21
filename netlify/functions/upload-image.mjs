export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  try {
    const formData = await req.formData();
    const password = formData.get('password');
    const file = formData.get('image');

    if (password !== process.env.ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    if (!file) {
      return new Response(JSON.stringify({ error: 'No image provided' }), { status: 400 });
    }

    const ext = file.name.split('.').pop().toLowerCase();
    const contentTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
    const contentType = contentTypes[ext] || 'image/jpeg';
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
    const buffer = await file.arrayBuffer();

    const endpoint = process.env.R2_ENDPOINT;
    const bucket = process.env.R2_BUCKET_NAME;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secretKey = process.env.R2_SECRET_ACCESS_KEY;

    const url = `${endpoint}/${bucket}/${filename}`;
    const date = new Date();
    const dateStr = date.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateShort = dateStr.slice(0, 8);

    const bodyHash = await sha256hex(buffer);
    const canonicalHeaders = `content-type:${contentType}\nhost:${new URL(endpoint).host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${dateStr}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = `PUT\n/${bucket}/${filename}\n\n${canonicalHeaders}\n${signedHeaders}\n${bodyHash}`;

    const credentialScope = `${dateShort}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${await sha256hex(new TextEncoder().encode(canonicalRequest))}`;

    const signingKey = await getSigningKey(secretKey, dateShort, 'auto', 's3');
    const signature = await hmacHex(signingKey, stringToSign);

    const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const uploadRes = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-amz-content-sha256': bodyHash,
        'x-amz-date': dateStr,
        'Authorization': authorization,
      },
      body: buffer,
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error('R2 upload error:', err);
      throw new Error(`Upload failed: ${uploadRes.status}`);
    }

    const imageUrl = `${process.env.R2_PUBLIC_URL}/${filename}`;
    return new Response(JSON.stringify({ ok: true, imageUrl }), { status: 200 });

  } catch (err) {
    console.error('upload-image error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

async function sha256hex(data) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const cryptoKey = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, typeof data === 'string' ? new TextEncoder().encode(data) : data);
}

async function hmacHex(key, data) {
  const sig = await hmac(key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey(secret, date, region, service) {
  const kDate = await hmac('AWS4' + secret, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export const config = { path: "/api/upload-image" };
