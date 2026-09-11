import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetchDeals } from '@/services/deals';
import { Deal, dealKey } from '@/types/deal';

type DealsContextValue = {
  deals: Deal[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  favorites: Set<string>;
  refresh: () => Promise<void>;
  toggleFavorite: (deal: Deal) => void;
  isFavorite: (deal: Deal) => boolean;
  findDeal: (id: string) => Deal | undefined;
};

const FAVORITES_KEY = 'deals-aholic:favorites';
const HOURLY_REFRESH_MS = 60 * 60 * 1000;
const DealsContext = createContext<DealsContextValue | null>(null);

export function DealsProvider({ children }: PropsWithChildren) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestInFlight = useRef(false);
  const lastLoadedAt = useRef(0);

  const load = useCallback(async (mode: 'initial' | 'manual' | 'background' = 'initial') => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (mode === 'manual') setRefreshing(true);
    if (mode === 'initial') setLoading(true);
    try {
      setDeals(await fetchDeals());
      lastLoadedAt.current = Date.now();
      setError(null);
    } catch {
      setError('Deals could not be loaded. Pull down to try again.');
    } finally {
      requestInFlight.current = false;
      if (mode === 'initial') setLoading(false);
      if (mode === 'manual') setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load('initial');
    AsyncStorage.getItem(FAVORITES_KEY).then((stored) => {
      if (stored) setFavorites(new Set(JSON.parse(stored)));
    }).catch(() => undefined);

    const interval = setInterval(() => load('background'), HOURLY_REFRESH_MS);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastLoadedAt.current >= HOURLY_REFRESH_MS) load('background');
    });
    return () => {
      clearInterval(interval);
      appStateSubscription.remove();
    };
  }, [load]);

  const toggleFavorite = useCallback((deal: Deal) => {
    setFavorites((current) => {
      const next = new Set(current);
      const key = dealKey(deal);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify([...next])).catch(() => undefined);
      return next;
    });
  }, []);

  const value = useMemo<DealsContextValue>(() => ({
    deals,
    loading,
    refreshing,
    error,
    favorites,
    refresh: () => load('manual'),
    toggleFavorite,
    isFavorite: (deal) => favorites.has(dealKey(deal)),
    findDeal: (id) => deals.find((deal) => dealKey(deal) === id),
  }), [deals, loading, refreshing, error, favorites, load, toggleFavorite]);

  return <DealsContext.Provider value={value}>{children}</DealsContext.Provider>;
}

export function useDeals() {
  const value = useContext(DealsContext);
  if (!value) throw new Error('useDeals must be used inside DealsProvider');
  return value;
}
