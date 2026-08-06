import * as Linking from 'expo-linking';
import { Deal } from '@/types/deal';

export const API_BASE = 'https://deals-aholic.com';

export async function fetchDeals(signal?: AbortSignal): Promise<Deal[]> {
  const response = await fetch(`${API_BASE}/api/deals`, { signal });
  if (!response.ok) throw new Error(`Deals request failed (${response.status})`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : payload.deals || [];
}

export async function openAffiliateDeal(deal: Deal) {
  if (!deal.url) return;
  const isAmazon = /amazon\./i.test(deal.url) || String(deal.storeType).toLowerCase() === 'amazon';
  if (!isAmazon) {
    await Linking.openURL(deal.url);
    return;
  }

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
  await Linking.openURL(deal.url);
}
