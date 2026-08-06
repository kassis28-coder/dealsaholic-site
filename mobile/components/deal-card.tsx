import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { Deal, dealKey, retailerName, shareUrl } from '@/types/deal';

export function DealCard({ deal }: { deal: Deal }) {
  const { isFavorite, toggleFavorite } = useDeals();
  const favorite = isFavorite(deal);
  const retailer = retailerName(deal);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
      onPress={() => router.push({ pathname: '/deal/[id]', params: { id: dealKey(deal) } })}>
      <View style={styles.imageWrap}>
        {deal.image ? <Image source={{ uri: deal.image }} style={styles.image} contentFit="contain" transition={150} /> : <Ionicons name="image-outline" size={42} color={colors.line} />}
        {!!deal.discountPercent && <Text style={styles.discount}>{deal.discountPercent}% OFF</Text>}
      </View>
      <View style={styles.body}>
        <View style={styles.eyebrowRow}>
          <Text style={styles.retailer}>{retailer}</Text>
          {!!deal.discountCode && <Text style={styles.codeBadge}>PROMO CODE</Text>}
        </View>
        <Text style={styles.title} numberOfLines={3}>{deal.title}</Text>
        <View style={styles.priceRow}>
          <Text style={styles.price}>{String(deal.price || 'See price')}</Text>
          {!!deal.originalPrice && <Text style={styles.original}>{String(deal.originalPrice)}</Text>}
        </View>
        <View style={styles.actions}>
          <Pressable hitSlop={10} onPress={(event) => { event.stopPropagation(); toggleFavorite(deal); }}>
            <Ionicons name={favorite ? 'heart' : 'heart-outline'} size={24} color={favorite ? colors.red : colors.muted} />
          </Pressable>
          <Pressable hitSlop={10} onPress={(event) => { event.stopPropagation(); Share.share({ message: `Check out this deal: ${shareUrl(deal)}`, url: shareUrl(deal) }); }}>
            <Ionicons name="share-outline" size={24} color={colors.muted} />
          </Pressable>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: colors.line, marginBottom: 14 },
  pressed: { opacity: 0.82 },
  imageWrap: { height: 210, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', position: 'relative' },
  image: { width: '100%', height: '100%' },
  discount: { position: 'absolute', top: 12, right: 12, overflow: 'hidden', borderRadius: 20, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.green, color: '#fff', fontSize: 12, fontWeight: '800' },
  body: { padding: 15 },
  eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 },
  retailer: { color: colors.orangeDark, fontWeight: '800', fontSize: 12, textTransform: 'uppercase' },
  codeBadge: { color: colors.purple, backgroundColor: '#F0EBFF', borderRadius: 10, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 3, fontSize: 10, fontWeight: '800' },
  title: { color: colors.ink, fontSize: 16, lineHeight: 22, fontWeight: '700' },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 9, marginTop: 12 },
  price: { color: colors.ink, fontSize: 22, fontWeight: '900' },
  original: { color: colors.muted, textDecorationLine: 'line-through', fontSize: 14 },
  actions: { position: 'absolute', bottom: 17, right: 15, flexDirection: 'row', gap: 15 },
});
