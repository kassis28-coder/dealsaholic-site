import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { DealCard } from '@/components/deal-card';
import { ScreenState } from '@/components/screen-state';
import { CategoryDealRow } from '@/app/category/[name]';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { Deal, dealCategory, retailerName } from '@/types/deal';

const FILTERS = ['All', 'Amazon', 'Walmart', 'Target', 'Other'];
const CATEGORIES = [
  ['all', 'All categories'], ['electronics', '📱 Electronics'], ['fashion', '👗 Fashion'],
  ['home', '🏠 Home & Kitchen'], ['bedroom', '🛏️ Bedroom & Bedding'], ['bathroom', '🚿 Bathroom'],
  ['furniture', '🪑 Furniture'], ['kitchen', '🍳 Kitchen Appliances'], ['decor', '🕯️ Home Decor'],
  ['beauty', '🧴 Beauty'], ['toys', '🧸 Toys & Games'], ['books', '📚 Books'],
  ['sports', '🏋️ Sports & Outdoors'], ['pets', '🐾 Pet Supplies'], ['household', '🧹 Household'],
  ['promo', '🏷️ Promo Codes'],
] as const;
const FEATURED_CATEGORIES = [
  { value: 'promo', title: 'Promo Codes', subtitle: 'Extra savings at checkout', emoji: '🏷️', color: '#18B958' },
  { value: 'electronics', title: 'Tech Deals', subtitle: 'Next-level savings', emoji: '💻', color: '#08A9C4' },
  { value: 'household', title: 'Household Essentials', subtitle: 'Savings for every home', emoji: '🧹', color: '#F2777D' },
  { value: 'fashion', title: 'Fashion Deals', subtitle: 'Fresh looks for less', emoji: '👗', color: '#8A63D2' },
  { value: 'home', title: 'Home & Kitchen', subtitle: 'Upgrade every room', emoji: '🏠', color: '#FF8A1E' },
  { value: 'beauty', title: 'Beauty Deals', subtitle: 'Self-care savings', emoji: '🧴', color: '#E45896' },
  { value: 'toys', title: 'Toys & Games', subtitle: 'Fun for less', emoji: '🧸', color: '#238BE6' },
  { value: 'sports', title: 'Sports & Outdoors', subtitle: 'Move more, spend less', emoji: '🏋️', color: '#149B83' },
] as const;

export default function DealsScreen() {
  const { deals, loading, refreshing, refresh, error } = useDeals();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [category, setCategory] = useState('all');

  const filtered = useMemo(() => deals.filter((deal) => {
    const retailer = retailerName(deal);
    const retailerMatch = filter === 'All' || (filter === 'Other' ? !['Amazon', 'Walmart', 'Target'].includes(retailer) : retailer === filter);
    const categoryMatch = category === 'all' || (retailer === 'Amazon' && dealCategory(deal) === category);
    const searchText = `${deal.title} ${retailer} ${dealCategory(deal)} ${deal.discountCode || ''}`.toLowerCase();
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const textMatch = !terms.length || terms.every((term) => searchText.includes(term));
    return retailerMatch && categoryMatch && textMatch;
  }), [category, deals, filter, query]);

  const updateQuery = (value: string) => {
    setQuery(value);
    if (value.trim()) {
      setFilter('All');
      setCategory('all');
    }
  };

  const selectRetailer = (item: string) => {
    setFilter(item);
    if (item !== 'Amazon' && category !== 'all') setCategory('all');
  };

  const selectCategory = (value: string) => {
    setCategory(value);
    if (value !== 'all') setFilter('Amazon');
  };

  if (loading) return <ScreenState loading title="Finding today's best deals…" />;

  const showDiscoveryShelves = !query.trim() && filter === 'All' && category === 'all';
  const amazonDeals = deals.filter((deal) => retailerName(deal) === 'Amazon');
  const promoDeals = amazonDeals.filter((deal) => Boolean(deal.discountCode?.trim()));
  const endingSoonDeals = amazonDeals.filter((deal) => {
    if (!deal.expiresOn) return false;
    const remaining = new Date(deal.expiresOn).getTime() - Date.now();
    return remaining > 0 && remaining <= 48 * 60 * 60 * 1000;
  }).sort((a, b) => new Date(a.expiresOn || 0).getTime() - new Date(b.expiresOn || 0).getTime());
  const imageDeals = deals.filter((deal) => !!deal.image);
  const heroKeywords = [
    ['couch', 'sofa', 'sectional', 'recliner'],
    ['laptop', 'notebook', 'macbook', 'computer'],
    ['airpods', 'earbuds', 'headphones', 'wireless audio'],
  ];
  const heroDeals = heroKeywords.reduce<Deal[]>((selected, keywords) => {
    const match = imageDeals.find((deal) => !selected.includes(deal) && keywords.some((keyword) => deal.title.toLowerCase().includes(keyword)));
    if (match) selected.push(match);
    return selected;
  }, []);
  for (const deal of imageDeals) {
    if (heroDeals.length === 3) break;
    if (!heroDeals.includes(deal)) heroDeals.push(deal);
  }

  return <ScrollView
    style={styles.screen}
    contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.orange} />}>
      <View style={styles.disclaimer}>
        <Ionicons name="information-circle-outline" size={17} color={colors.orangeDark} />
        <Text style={styles.disclaimerText}>Deals-aholic may earn commissions from qualifying purchases.</Text>
        <Pressable style={styles.disclaimerButton} hitSlop={8} onPress={() => router.push('/disclosure' as never)}><Ionicons name="chevron-forward" size={18} color={colors.orangeDark} /></Pressable>
      </View>
      <View style={styles.hero}>
        <View style={styles.heroCopy}>
          <Text style={styles.kicker}>NEW SAVINGS EVERY DAY</Text>
          <Text style={styles.heroTitle}>Save on what you love.</Text>
          <Text style={styles.heroText}>Fresh deals, promo codes and price drops every day.</Text>
          <Pressable style={styles.heroButton} onPress={() => router.push({ pathname: '/category/[name]', params: { name: 'hot', title: "Today's Deals" } } as never)}><Text style={styles.heroButtonText}>Explore deals →</Text></Pressable>
        </View>
        <View style={styles.heroProducts}>
          {heroDeals.map((deal, index) => <View key={deal.id || deal.asin || `${index}`} style={[styles.productBubble, index === 0 ? styles.bubbleOne : index === 1 ? styles.bubbleTwo : styles.bubbleThree]}>
            <Image source={{ uri: deal.image! }} style={styles.heroImage} contentFit="contain" transition={150} />
          </View>)}
          {!heroDeals.length && <View style={[styles.productBubble, styles.bubbleOne]}><Ionicons name="pricetag" size={38} color={colors.orange} /></View>}
        </View>
      </View>
      <View style={styles.search}>
        <Ionicons name="search" size={20} color={colors.muted} />
        <TextInput value={query} onChangeText={updateQuery} placeholder="Search deals or retailers" placeholderTextColor={colors.muted} style={styles.searchInput} autoCapitalize="none" returnKeyType="search" clearButtonMode="while-editing" />
        {!!query && <Pressable onPress={() => setQuery('')}><Ionicons name="close-circle" size={20} color={colors.muted} /></Pressable>}
      </View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel="Join the Deals-aholic Telegram channel"
        style={styles.telegramBanner}
        onPress={() => Linking.openURL('https://t.me/dealsaholic')}>
        <View style={styles.telegramIcon}><Ionicons name="paper-plane" size={23} color="#FFFFFF" /></View>
        <View style={styles.telegramCopy}>
          <Text style={styles.telegramTitle}>Join Deals-aholic on Telegram</Text>
          <Text style={styles.telegramText}>Get fresh deals and promo codes delivered directly to you.</Text>
        </View>
        <View style={styles.telegramButton}><Text style={styles.telegramButtonText}>Join</Text><Ionicons name="chevron-forward" size={15} color="#168AC2" /></View>
      </Pressable>
      {showDiscoveryShelves && <>
        <DealShelf title="🔥 Today's Deals" deals={deals.slice(0, 12)} viewAll="hot" />
        {!!promoDeals.length && <DealShelf title="🏷️ Promo Codes" deals={promoDeals.slice(0, 12)} viewAll="promo" />}
        {!!endingSoonDeals.length && <DealShelf title="⏰ Ending Soon" deals={endingSoonDeals.slice(0, 12)} viewAll="ending" />}
        <View style={styles.exploreHeader}>
          <View>
            <Text style={styles.exploreTitle}>Explore</Text>
            <Text style={styles.exploreCount}>{deals.length.toLocaleString()} active deals from the website</Text>
          </View>
          <Pressable
            style={styles.viewAll}
            onPress={() => router.push({ pathname: '/category/[name]', params: { name: 'hot', title: 'All Deals' } } as never)}>
            <Text style={styles.viewAllText}>View All ›</Text>
          </Pressable>
        </View>
      </>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.featuredCategories}>
        {FEATURED_CATEGORIES.map((item) => <Pressable
          key={item.value}
          style={[styles.featuredCategory, { backgroundColor: item.color }]}
          onPress={() => router.push({ pathname: '/category/[name]', params: { name: item.value, title: item.title } } as never)}>
          <Text style={styles.featuredTitle}>{item.title}</Text>
          <Text style={styles.featuredSubtitle}>{item.subtitle}</Text>
          <Text style={styles.featuredEmoji}>{item.emoji}</Text>
          <View style={styles.shopPill}><Text style={styles.shopPillText}>View all deals →</Text></View>
        </Pressable>)}
      </ScrollView>
      <View style={styles.filters}>{FILTERS.map((item) => <Pressable key={item} onPress={() => selectRetailer(item)} style={[styles.filter, item === filter && styles.filterActive]}><Text style={[styles.filterText, item === filter && styles.filterTextActive]}>{item}</Text></Pressable>)}</View>
      <Text style={styles.categoryLabel}>AMAZON CATEGORIES</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>
        {CATEGORIES.map(([value, label]) => <Pressable key={value} onPress={() => selectCategory(value)} style={[styles.category, value === category && styles.categoryActive]}><Text style={[styles.categoryText, value === category && styles.categoryTextActive]}>{label}</Text></Pressable>)}
      </ScrollView>
      {!!error && <Text style={styles.error}>{error}</Text>}
      {showDiscoveryShelves ? <>
        <View style={styles.exploreList}>{deals.slice(12, 22).map((deal, index) => <CategoryDealRow key={deal.id || deal.asin || `${deal.url}-${index}`} deal={deal} />)}</View>
      </> : <>
        <Text style={styles.count}>{filtered.length.toLocaleString()} deals</Text>
        {filtered.length ? <View style={styles.exploreList}>
          {filtered.map((deal, index) => <CategoryDealRow key={deal.id || deal.asin || `${deal.url}-${index}`} deal={deal} />)}
        </View> : <ScreenState title="No deals found" message="Try a different search, retailer, or category." />}
      </>}
    </ScrollView>;
}

function DealShelf({ title, deals, viewAll }: { title: string; deals: Deal[]; viewAll?: string }) {
  if (!deals.length) return <ScreenState title="No deals found" message="Try a different search, retailer, or category." />;
  return <View style={styles.shelf}>
    <View style={styles.shelfHeader}><Text style={styles.shelfTitle}>{title}</Text>{viewAll ? <Pressable onPress={() => router.push({ pathname: '/category/[name]', params: { name: viewAll, title: title.replace(/^[^A-Za-z]+/, '') } } as never)} style={styles.viewAll}><Text style={styles.viewAllText}>View All ›</Text></Pressable> : <Text style={styles.swipeHint}>Swipe to see more ›</Text>}</View>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shelfContent}>
      {deals.map((item, index) => <DealCard key={item.id || item.asin || `${item.url}-${index}`} deal={item} compact shelf />)}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  content: { padding: 16, paddingBottom: 30, backgroundColor: colors.cream, flexGrow: 1 },
  disclaimer: { backgroundColor: '#FFF3E0', borderRadius: 12, borderWidth: 1, borderColor: '#FFD6A5', paddingHorizontal: 12, paddingVertical: 9, marginBottom: 12, flexDirection: 'row', alignItems: 'center' },
  disclaimerText: { flex: 1, color: colors.muted, fontSize: 10, lineHeight: 15, marginLeft: 6 },
  disclaimerButton: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFE0B2' },
  hero: { minHeight: 260, backgroundColor: '#08A9C4', borderRadius: 22, padding: 20, marginBottom: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#078BA3' },
  heroCopy: { width: '62%', zIndex: 2 },
  kicker: { color: '#DFFFFF', fontSize: 10, fontWeight: '900', letterSpacing: 1.1 },
  heroTitle: { color: '#FFFFFF', fontSize: 29, lineHeight: 33, fontWeight: '900', marginTop: 8 },
  heroText: { color: '#E8FCFF', fontSize: 13, lineHeight: 19, marginTop: 8 },
  heroButton: { alignSelf: 'flex-start', backgroundColor: colors.orange, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, marginTop: 14 },
  heroButtonText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  heroProducts: { position: 'absolute', right: 0, top: 0, width: '48%', height: '100%' },
  productBubble: { position: 'absolute', backgroundColor: '#fff', borderWidth: 2, borderColor: '#8BE8F5', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', shadowColor: '#075985', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
  bubbleOne: { width: 126, height: 126, borderRadius: 63, right: 8, top: 14 },
  bubbleTwo: { width: 100, height: 100, borderRadius: 50, right: 72, top: 132 },
  bubbleThree: { width: 86, height: 86, borderRadius: 43, right: 2, top: 166 },
  heroImage: { width: '92%', height: '92%' },
  search: { height: 50, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.card, borderRadius: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15 },
  telegramBanner: { minHeight: 76, marginTop: 12, borderRadius: 17, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 11, backgroundColor: '#DFF4FF', borderWidth: 1, borderColor: '#9BD9F5' },
  telegramIcon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#229ED9' },
  telegramCopy: { flex: 1 },
  telegramTitle: { color: '#075985', fontSize: 14, fontWeight: '900' },
  telegramText: { color: '#39758F', fontSize: 10.5, lineHeight: 15, marginTop: 2 },
  telegramButton: { minWidth: 61, height: 34, borderRadius: 17, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', gap: 1 },
  telegramButtonText: { color: '#168AC2', fontSize: 12, fontWeight: '900' },
  featuredCategories: { gap: 12, paddingVertical: 14, paddingRight: 12 },
  exploreHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, marginTop: 14 },
  exploreTitle: { color: colors.ink, fontSize: 27, fontWeight: '900' },
  exploreCount: { color: colors.muted, fontSize: 11, fontWeight: '700', marginTop: 3 },
  exploreList: { backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 12, overflow: 'hidden' },
  featuredCategory: { width: 278, height: 210, borderRadius: 22, padding: 18, overflow: 'hidden' },
  featuredTitle: { color: '#fff', fontSize: 27, lineHeight: 30, fontWeight: '900', maxWidth: 215, paddingRight: 18 },
  featuredSubtitle: { color: 'rgba(255,255,255,0.92)', fontSize: 13, lineHeight: 17, fontWeight: '700', marginTop: 6, maxWidth: 210, paddingRight: 14 },
  featuredEmoji: { position: 'absolute', right: 12, top: 12, fontSize: 38, opacity: 0.78 },
  shopPill: { position: 'absolute', left: 18, bottom: 16, backgroundColor: colors.orange, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8 },
  shopPillText: { color: '#fff', fontSize: 12, fontWeight: '900' },
  filters: { flexDirection: 'row', gap: 8, marginVertical: 13 },
  filter: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, backgroundColor: '#EEE8DE' },
  filterActive: { backgroundColor: colors.orange },
  filterText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  filterTextActive: { color: '#fff' },
  categoryLabel: { color: colors.muted, fontSize: 11, fontWeight: '900', letterSpacing: 0.8, marginTop: 2 },
  categories: { gap: 8, paddingVertical: 10, paddingRight: 16 },
  category: { paddingHorizontal: 13, paddingVertical: 9, borderRadius: 18, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  categoryActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  categoryText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  categoryTextActive: { color: '#fff' },
  shelf: { marginTop: 12, marginBottom: 14 },
  shelfHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 },
  shelfTitle: { color: colors.ink, fontSize: 21, fontWeight: '900', flex: 1 },
  swipeHint: { color: colors.orangeDark, fontSize: 11, fontWeight: '800' },
  viewAll: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18 },
  viewAllText: { color: colors.orangeDark, fontSize: 12, fontWeight: '900' },
  shelfContent: { paddingRight: 4 },
  count: { color: colors.muted, fontSize: 12, fontWeight: '700', marginBottom: 10 },
  error: { color: colors.red, marginBottom: 8, fontSize: 13 },
});
