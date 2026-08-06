import { FlatList, RefreshControl, StyleSheet } from 'react-native';
import { DealCard } from '@/components/deal-card';
import { ScreenState } from '@/components/screen-state';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { dealKey } from '@/types/deal';

export default function FavoritesScreen() {
  const { deals, favorites, refreshing, refresh } = useDeals();
  const items = deals.filter((deal) => favorites.has(dealKey(deal)));
  return <FlatList
    data={items}
    keyExtractor={(item) => dealKey(item)}
    renderItem={({ item }) => <DealCard deal={item} />}
    contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.orange} />}
    ListEmptyComponent={<ScreenState title="No favorites yet" message="Tap the heart on a deal to save it here." />}
  />;
}

const styles = StyleSheet.create({ content: { padding: 16, flexGrow: 1, backgroundColor: colors.cream } });
