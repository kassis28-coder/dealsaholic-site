import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { ScreenState } from '@/components/screen-state';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { Deal, dealCategory, dealKey, retailerName } from '@/types/deal';

export default function CategoryDealsScreen() {
  const params = useLocalSearchParams<{ name: string; title?: string }>();
  const category = String(params.name || '');
  const title = String(params.title || 'Category Deals');
  const { deals, refreshing, refresh } = useDeals();
  const amazonDeals = deals.filter((deal) => retailerName(deal) === 'Amazon');
  const items = category === 'hot'
    ? deals
    : category === 'promo'
      ? amazonDeals.filter((deal) => Boolean(deal.discountCode?.trim()))
    : category === 'ending'
      ? amazonDeals.filter((deal) => {
          if (!deal.expiresOn) return false;
          const remaining = new Date(deal.expiresOn).getTime() - Date.now();
          return remaining > 0 && remaining <= 48 * 60 * 60 * 1000;
        }).sort((a, b) => new Date(a.expiresOn || 0).getTime() - new Date(b.expiresOn || 0).getTime())
      : amazonDeals.filter((deal) => dealCategory(deal) === category);

  return <>
    <Stack.Screen options={{ title }} />
    <FlatList
      data={items}
      keyExtractor={(item, index) => dealKey(item) || `${index}`}
      renderItem={({ item }) => <CategoryDealRow deal={item} />}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.orange} />}
      ListHeaderComponent={<View style={styles.header}><Text style={styles.title}>{title}</Text><Text style={styles.count}>{items.length.toLocaleString()} available deals</Text></View>}
      ListEmptyComponent={<ScreenState title="No deals in this category" message="Pull down to refresh and check again." />}
    />
  </>;
}

export function CategoryDealRow({ deal }: { deal: Deal }) {
  const { isFavorite, toggleFavorite } = useDeals();
  const favorite = isFavorite(deal);
  return <Pressable style={({ pressed }) => [styles.dealRow, pressed && styles.pressed]} onPress={() => router.push({ pathname: '/deal/[id]', params: { id: dealKey(deal) } })}>
    <View style={styles.imageWrap}>
      {deal.image ? <Image source={{ uri: deal.image }} style={styles.image} contentFit="contain" /> : <Ionicons name="image-outline" size={38} color={colors.line} />}
      <Text style={styles.storeBadge}>Amazon</Text>
    </View>
    <View style={styles.dealBody}>
      <View style={styles.tagRow}>
        <Text style={[styles.dealTag, deal.discountCode ? styles.promoTag : styles.priceDropTag]}>{deal.discountCode ? '🏷 Promo Code' : '✧ Price Drop'}</Text>
        <Pressable hitSlop={10} onPress={(event) => { event.stopPropagation(); toggleFavorite(deal); }}><Ionicons name={favorite ? 'heart' : 'heart-outline'} size={25} color={favorite ? colors.red : colors.muted} /></Pressable>
      </View>
      <Text style={styles.dealTitle} numberOfLines={3}>{deal.title}</Text>
      <View style={styles.priceRow}>
        {!!deal.discountPercent && <Text style={styles.discount}>-{deal.discountPercent}%</Text>}
        <Text style={styles.price}>{String(deal.price || 'See price')}</Text>
        {!!deal.originalPrice && <Text style={styles.original}>{String(deal.originalPrice)}</Text>}
      </View>
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  content: { padding: 14, paddingBottom: 30, backgroundColor: colors.cream, flexGrow: 1 },
  header: { marginBottom: 14 },
  title: { color: colors.ink, fontSize: 27, fontWeight: '900' },
  count: { color: colors.muted, fontSize: 13, marginTop: 5 },
  dealRow: { flexDirection: 'row', gap: 13, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.card },
  pressed: { opacity: 0.8 },
  imageWrap: { width: 132, height: 142, borderRadius: 13, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  image: { width: '100%', height: '100%' },
  storeBadge: { position: 'absolute', left: 6, bottom: 4, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3, color: colors.muted, fontSize: 10, fontWeight: '700' },
  dealBody: { flex: 1, paddingRight: 4 },
  tagRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 27 },
  dealTag: { fontSize: 12, fontWeight: '900' },
  promoTag: { color: colors.green },
  priceDropTag: { color: colors.purple },
  dealTitle: { color: colors.ink, fontSize: 16, lineHeight: 21, fontWeight: '800', marginTop: 3 },
  priceRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7, marginTop: 9 },
  discount: { backgroundColor: colors.red, color: '#fff', borderRadius: 16, overflow: 'hidden', paddingHorizontal: 9, paddingVertical: 5, fontWeight: '800', fontSize: 12 },
  price: { color: colors.ink, fontSize: 22, fontWeight: '900' },
  original: { color: colors.muted, textDecorationLine: 'line-through', fontSize: 12 },
});
