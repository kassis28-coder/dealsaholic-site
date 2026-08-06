import { Stack, useLocalSearchParams } from 'expo-router';
import { FlatList, StyleSheet } from 'react-native';
import { DealCard } from '@/components/deal-card';
import { ScreenState } from '@/components/screen-state';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { dealKey, retailerName } from '@/types/deal';

export default function RetailerDealsScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const { deals } = useDeals();
  const decoded = decodeURIComponent(name || 'Retailer');
  const items = deals.filter((deal) => retailerName(deal) === decoded);
  return <>
    <Stack.Screen options={{ title: decoded }} />
    <FlatList data={items} keyExtractor={dealKey} renderItem={({ item }) => <DealCard deal={item} />} contentContainerStyle={styles.content} ListEmptyComponent={<ScreenState title="No active deals" />} />
  </>;
}

const styles = StyleSheet.create({ content: { padding: 16, flexGrow: 1, backgroundColor: colors.cream } });
