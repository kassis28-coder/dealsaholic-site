import { getStore } from '@netlify/blobs';

const ADULT_PRODUCT_RE = /\b(?:adult\s+(?:toy|novelty|product)|sex(?:ual)?\s+(?:toy|aid|product)|vibrators?|dildos?|masturbators?|mastubators?|masturbation|male\s+enhancement|penis\s+(?:pump|ring)|cock\s+ring|butt\s+plug|anal\s+(?:plug|toy|beads)|bondage\s+(?:gear|kit|toy)|erotic\s+(?:toy|massager)|love\s+doll)\b/i;

function extractAsin(record) {
  if (/^[A-Z0-9]{10}$/i.test(record.asin || '')) return record.asin.toUpperCase();
  const url = record.productUrl || record.url || record.amazonUrl || '';
  return url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() || null;
}

function titleTokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function titleMatchScore(left, right) {
  const expected = titleTokens(left);
  const actual = titleTokens(right);
  if (!expected.size || !actual.size) return 0;
  let matches = 0;
  for (const token of expected) if (actual.has(token)) matches++;
  return matches / expected.size;
}

function decodeImageUrl(value) {
  return String(value || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u003d/gi, '=')
    .replace(/\\\//g, '/');
}

async function fetchAmazonMeta(asin) {
  if (!asin) return {};
  try {
    const response = await fetch(`https://www.amazon.com/dp/${asin}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return {};
    const html = await response.text();
    const title = html.match(/<span[^>]*id=["']productTitle["'][^>]*>\s*([^<]+?)\s*<\/span>/i)?.[1]?.trim()
      || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim()
      || null;
    const imageCandidate = html.match(/["']hiRes["']\s*:\s*["'](https?(?:\\.|[^"'])+)["']/i)?.[1]
      || html.match(/["']large["']\s*:\s*["'](https?(?:\\.|[^"'])+)["']/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || null;
    const image = decodeImageUrl(imageCandidate);
    return { title, image: /^https:\/\//i.test(image) ? image : null };
  } catch (error) {
    console.warn(`[audit-email-deals] Amazon lookup failed for ${asin}: ${error.message}`);
    return {};
  }
}

export default async (req) => {
  const requestUrl = new URL(req.url);
  const password = requestUrl.searchParams.get('password');
  const dry = requestUrl.searchParams.get('dry') === '1';
  const limit = Math.max(0, parseInt(requestUrl.searchParams.get('limit') || '0', 10) || 0);

  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const store = getStore('submissions');
    const index = await store.get('index', { type: 'json', consistency: 'strong' }).catch(() => []) || [];
    const results = { total: index.length, processed: 0, approved: 0, pending: 0, rejectedDuplicate: 0, rejectedAdult: 0, skipped: 0, log: [] };
    const seenAsins = new Set();

    for (const id of index) {
      if (limit && results.processed >= limit) break;
      const record = await store.get(id, { type: 'json', consistency: 'strong' }).catch(() => null);
      if (!record || record.source !== 'email' || !['pending', 'needs-review', 'approved'].includes(record.status)) {
        results.skipped++;
        continue;
      }

      // Shopper reports are post-publication review items. Leave those for the
      // admin review workflow instead of treating them as verification work.
      if (record.status === 'needs-review' && (record.flaggedAt || record.flagReason)) {
        results.skipped++;
        continue;
      }
      results.processed++;

      const currentTitle = record.productTitle || record.title || '';
      const asin = extractAsin(record);

      // The index is newest-first. Keep the newest copy eligible for approval
      // and pull every older copy of the same ASIN out of the public feed.
      if (asin && seenAsins.has(asin)) {
        if (!dry) {
          record.status = 'rejected';
          record.reviewReason = `duplicate Amazon product (${asin})`;
          record.autoApproved = false;
          record.reviewedAt = new Date().toISOString();
          await store.setJSON(id, record);
        }
        results.rejectedDuplicate++;
        results.log.push({ id, title: currentTitle, asin, status: 'rejected', issues: ['duplicate deal'] });
        continue;
      }
      if (asin) seenAsins.add(asin);

      if (ADULT_PRODUCT_RE.test(currentTitle)) {
        if (!dry) {
          record.status = 'rejected';
          record.reviewReason = 'blocked adult product';
          record.reviewedAt = new Date().toISOString();
          await store.setJSON(id, record);
        }
        results.rejectedAdult++;
        results.log.push({ id, title: currentTitle, status: 'rejected', reason: 'adult product' });
        continue;
      }

      const meta = await fetchAmazonMeta(asin);
      if (ADULT_PRODUCT_RE.test(meta.title || '')) {
        if (!dry) {
          record.status = 'rejected';
          record.reviewReason = 'blocked adult product';
          record.reviewedAt = new Date().toISOString();
          await store.setJSON(id, record);
        }
        results.rejectedAdult++;
        results.log.push({ id, title: currentTitle, status: 'rejected', reason: 'adult product' });
        continue;
      }

      const resolvedTitle = currentTitle || meta.title || '';
      const matchScore = titleMatchScore(resolvedTitle, meta.title);
      const issues = [];
      if (!asin) issues.push('missing ASIN');
      if (!resolvedTitle) issues.push('missing title');
      if (!meta.image) issues.push('missing verified image');
      if (!/^[A-Z0-9]{4,20}$/i.test(String(record.discountCode || '').trim())) issues.push('missing or invalid promo code');
      const titleAndImageVerified = Boolean(asin && meta.image && resolvedTitle && (!meta.title || matchScore >= 0.5));
      if (!titleAndImageVerified) issues.push('title/image match could not be verified');

      const approved = issues.length === 0;
      if (!dry) {
        record.asin = asin;
        record.productTitle = resolvedTitle;
        record.title = resolvedTitle;
        if (meta.image) {
          record.image = meta.image;
          record.imageUrl = meta.image;
          record.photoUrl = meta.image;
        }
        record.status = approved ? 'approved' : 'pending';
        record.reviewReason = approved ? null : issues.join('; ');
        record.autoApproved = approved;
        record.titleMatchScore = Number(matchScore.toFixed(2));
        record.reviewedAt = approved ? new Date().toISOString() : null;
        await store.setJSON(id, record);
      }

      if (approved) results.approved++;
      else results.pending++;
      results.log.push({ id, title: resolvedTitle, asin, status: approved ? 'approved' : 'pending', issues });
    }

    return new Response(JSON.stringify({ dry, ...results }, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/audit-email-deals' };
