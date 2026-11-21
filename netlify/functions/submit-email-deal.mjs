import { getStore } from "@netlify/blobs";

const AFFILIATE_TAG = process.env.AMAZON_PARTNER_TAG || 'daholic-20';

// Explicit sexual/adult products are never stored. Keep this deliberately
// specific so ordinary products that merely use words such as "adult size"
// are not accidentally blocked.
const ADULT_PRODUCT_RE = /\b(?:adult\s+(?:toy|novelty|product)|sex(?:ual)?\s+(?:toy|aid|product)|vibrators?|dildos?|masturbators?|mastubators?|masturbation|male\s+enhancement|penis\s+(?:pump|ring)|cock\s+ring|butt\s+plug|anal\s+(?:plug|toy|beads)|bondage\s+(?:gear|kit|toy)|erotic\s+(?:toy|massager)|love\s+doll)\b/i;

function isAdultProduct(value) {
  return ADULT_PRODUCT_RE.test(String(value || ''));
}

function isValidPromoCode(value) {
  return /^[A-Z0-9]{4,20}$/i.test(String(value || '').trim());
}

// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
// HTML / TEXT UTILITIES
// âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

function stripHtml(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

function htmlToTextWithLines(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<\/?(?:p|div|tr|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEmailImage(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/\\u0026/gi, '&').replace(/\\u003d/gi, '=').replace(/\\\\\\//g, '/')
    .replace(/^['"]|['"]$/g, '').trim();
}

function isRetailerImage(value) {
  const url = decodeEmailImage(value).replace(/^\\s+|\\s+$/g, '');
  return /^https?:\\/\\//i.test(url) || /^\\/\\//.test(url);
}

function normalizeEmailImage(value) {
  let url = decodeEmailImage(value).replace(/[\\"'<>\\s,]+$/, '');
  if (url.startsWith('//')) url = 'https:' + url;
  return url;
}

function extractCdnImages(html) {
  const source = decodeEmailImage(html);
  const seen = new Set();
  const images = [];
  const add = (value) => {
    const clean = normalizeEmailImage(value);
    if (!isRetailerImage(clean) || /(?:pixel|tracking|transparent|spacer|sprite|logo|icon|badge)/i.test(clean)) return;
    if (!seen.has(clean)) { seen.add(clean); images.push(clean); }
  };
  const urlPattern = /(?:https?:\\/\\/|\\/\\/)[^\\s"'<>]+/gi;
  for (const url of source.match(urlPattern) || []) add(url);
  for (const tag of source.match(/<img\\b[^>]*>/gi) || []) {
    for (const match of tag.matchAll(/\\b(?:src|data-src|data-original|data-lazy-src|data-image|data-fallback-src)\\s*=\\s*["']([^"']+)["']/gi)) add(match[1]);
    const srcset = tag.match(/\\bsrcset\\s*=\\s*["']([^"']+)["']/i)?.[1] || '';
    for (const item of srcset.split(',')) add(item.trim().split(/\\s+/)[0]);
    const dynamic = tag.match(/data-a-dynamic-image\\s*=\\s*["']([^"']+)["']/i)?.[1];
    if (dynamic) { try { Object.keys(JSON.parse(dynamic)).forEach(add); } catch {} }
  }
  return images;
}
