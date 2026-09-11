import * as Linking from 'expo-linking';
import { Deal } from '@/types/deal';

export const API_BASE = 'https://deals-aholic.com';
const AMAZON_FALLBACK_TAG = 'daholic-20';
const WALMART_IMPACT_PREFIX = 'https://goto.walmart.com/c/1788825/1398372/16662?u=';

export async function fetchDeals(signal?: AbortSignal): Promise<Deal[]> {
  const response = await fetch(`${API_BASE}/api/deals`, { signal });
  if (!response.ok) throw new Error(`Deals request failed (${response.status})`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : payload.deals || [];
}

export async function openAffiliateDeal(deal: Deal) {
  if (!deal.url) return;
  const isAmazon = /amazon\./i.test(deal.url) || String(deal.storeType).toLowerCase() === 'amazon';
  const isWalmart = /walmart\./i.test(deal.url) || String(deal.storeType).toLowerCase() === 'walmart';
  const isTarget = /(?:^|\.)target\.com/i.test(safeHostname(deal.url)) || String(deal.storeType).toLowerCase() === 'target';

  if (isWalmart) {
    const trackedUrl = /goto\.walmart\.com\/c\/1788825\//i.test(deal.url)
      ? deal.url
      : `${WALMART_IMPACT_PREFIX}${encodeURIComponent(deal.url)}`;
    await Linking.openURL(trackedUrl);
    return;
  }

  // Target links are created with Target's own Impact campaign on the server.
  // Never reuse Walmart campaign identifiers for Target.
  if (isTarget) {
    await Linking.openURL(deal.url);
    return;
  }

  if (!isAmazon) {
    await Linking.openURL(deal.url);
    return;
  }

  const amazonFallback = buildAmazonFallback(deal);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(`${API_BASE}/api/create-joylink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: deal.url, asin: deal.asin || null }),
      signal: controller.signal,
    });
    const result = await response.json();
    if (response.ok && result.url) {
      await Linking.openURL(result.url);
      return;
    }
  } catch {
    // The raw affiliate URL is the required fallback.
  } finally {
    clearTimeout(timeout);
  }
  await Linking.openURL(amazonFallback);
}

function safeHostname(value: string) {
  try { return new URL(value).hostname; } catch { return ''; }
}

function buildAmazonFallback(deal: Deal) {
  if (deal.asin && /^[A-Z0-9]{10}$/i.test(deal.asin)) {
    return `https://www.amazon.com/dp/${deal.asin}?tag=${AMAZON_FALLBACK_TAG}&linkCode=ll1&language=en_US`;
  }

  try {
    const url = new URL(deal.url);
    if (/amazon\./i.test(url.hostname)) {
      url.searchParams.set('tag', AMAZON_FALLBACK_TAG);
      return url.toString();
    }
  } catch {
    // Keep the saved URL when it cannot be parsed.
  }
  return deal.url;
}
