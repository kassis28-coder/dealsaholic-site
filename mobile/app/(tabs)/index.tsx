import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { DealCard } from '@/components/deal-card';
import { ScreenState } from '@/components/screen-state';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { retailerName } from '@/types/deal';

const FILTERS = ['All', 'Amazon', 'Walmart', 'Other'];

export default function DealsScreen() {
  const { deals, loading, refreshing, refresh, error } = useDeals();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');

  const filtered = useMemo(() => deals.filter((deal) => {
    const retailer = retailerName(deal);
    const retailerMatch = filter === 'All' || (filter === 'Other' ? !['Amazon', 'Walmart'].includes(retailer) : retailer === filter);
    const textMatch = !query.trim() || `${deal.title} ${retailer}`.toLowerCase().includes(query.trim().toLowerCase());
    return retailerMatch && textMatch;
  }), [deals, filter, query]);

  if (loading) return <ScreenState loading title="Finding today's best deals…" />;

  return <FlatList
    data={filtered}
    keyExtractor={(item, index) => item.id || item.asin || `${item.url}-${index}`}
    renderItem={({ item }) => <DealCard deal={item} />}
    contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.orange} />}
    ListHeaderComponent={<>
      <View style={styles.hero}>
        <Text style={styles.kicker}>NEW DEALS EVERY DAY</Text>
        <Text style={styles.heroTitle}>Save more. Shop smarter.</Text>
        <Text style={styles.heroText}>Amazon, Walmart, promo codes, and hand-picked savings from more retailers.</Text>
      </View>
      <View style={styles.search}>
        <Ionicons name="search" size={20} color={colors.muted} />
        <TextInput value={query} onChangeText={setQuery} placeholder="Search deals or retailers" placeholderTextColor={colors.muted} style={styles.searchInput} autoCapitalize="none" />
        {!!query && <Pressable onPress={() => setQuery('')}><Ionicons name="close-circle" size={20} color={colors.muted} /></Pressable>}
      </View>
      <View style={styles.filters}>{FILTERS.map((item) => <Pressable key={item} onPress={() => setFilter(item)} style={[styles.filter, item === filter && styles.filterActive]}><Text style={[styles.filterText, item === filter && styles.filterTextActive]}>{item}</Text></Pressable>)}</View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.count}>{filtered.length.toLocaleString()} deals</Text>
    </>}
    ListEmptyComponent={<ScreenState title="No deals found" message="Try a different search or retailer." />}
  />;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 30, backgroundColor: colors.cream, flexGrow: 1 },
  hero: { backgroundColor: colors.ink, borderRadius: 22, padding: 22, marginBottom: 14 },
  kicker: { color: colors.orange, fontSize: 11, fontWeight: '900', letterSpacing: 1.2 },
  heroTitle: { color: '#fff', fontSize: 28, lineHeight: 33, fontWeight: '900', marginTop: 7 },
  heroText: { color: '#D9D3CA', fontSize: 14, lineHeight: 20, marginTop: 8 },
  search: { height: 50, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15 },
  filters: { flexDirection: 'row', gap: 8, marginVertical: 13 },
  filter: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: '#EEE8DE' },
  filterActive: { backgroundColor: colors.orange },
  filterText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  filterTextActive: { color: '#fff' },
  count: { color: colors.muted, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  error: { color: colors.red, marginBottom: 8, fontSize: 13 },
});
