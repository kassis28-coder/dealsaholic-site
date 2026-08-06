export type Deal = {
  id?: string;
  asin?: string | null;
  title: string;
  image?: string | null;
  price?: string | number | null;
  originalPrice?: string | number | null;
  discountPercent?: number | null;
  discountCode?: string | null;
  url: string;
  storeType?: string | null;
  source?: string | null;
  createdAt?: string | null;
  fetchedAt?: string | null;
};

export const dealKey = (deal: Deal) => deal.id || deal.asin || deal.url;

export function retailerName(deal: Deal) {
  const explicit = String(deal.storeType || '').trim().toLowerCase();
  if (explicit && explicit !== 'other') {
    if (explicit === 'amazon') return 'Amazon';
    if (explicit === 'walmart') return 'Walmart';
    return explicit.replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, '').toUpperCase());
  }
  try {
    const host = new URL(deal.url).hostname.replace(/^www\./, '');
    if (host.includes('amazon.')) return 'Amazon';
    if (host.includes('walmart.')) return 'Walmart';
    return host.split('.')[0].replace(/(^|[-_])\w/g, (value) => value.replace(/[-_]/, '').toUpperCase());
  } catch {
    return 'Other Retailer';
  }
}

export function shareUrl(deal: Deal) {
  const key = deal.id || deal.asin;
  return key
    ? `https://deals-aholic.com/d/${encodeURIComponent(key)}?preview=2`
    : 'https://deals-aholic.com';
}
