import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { retailerName } from '@/types/deal';

export default function RetailersScreen() {
  const { deals } = useDeals();
  const retailers = useMemo(() => {
    const counts = new Map<string, number>();
    deals.forEach((deal) => counts.set(retailerName(deal), (counts.get(retailerName(deal)) || 0) + 1));
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  }, [deals]);

  return <FlatList
    data={retailers}
    keyExtractor={(item) => item.name}
    contentContainerStyle={styles.content}
    ListHeaderComponent={<View style={styles.intro}><Text style={styles.title}>Shop by retailer</Text><Text style={styles.copy}>Amazon and Walmart appear automatically. Any approved deal from another store is listed here too.</Text></View>}
    renderItem={({ item }) => <Pressable style={styles.row} onPress={() => router.push({ pathname: '/retailer/[name]', params: { name: item.name } })}>
      <View style={styles.icon}><Ionicons name={item.name === 'Amazon' ? 'logo-amazon' : 'storefront'} size={24} color={colors.orangeDark} /></View>
      <View style={styles.body}><Text style={styles.name}>{item.name}</Text><Text style={styles.count}>{item.count.toLocaleString()} active deals</Text></View>
      <Ionicons name="chevron-forward" size={21} color={colors.muted} />
    </Pressable>}
  />;
}

const styles = StyleSheet.create({
  content: { padding: 16, backgroundColor: colors.cream, flexGrow: 1 },
  intro: { marginBottom: 14 }, title: { color: colors.ink, fontSize: 25, fontWeight: '900' }, copy: { color: colors.muted, marginTop: 6, lineHeight: 20 },
  row: { backgroundColor: colors.card, borderColor: colors.line, borderWidth: 1, borderRadius: 16, padding: 15, marginBottom: 10, flexDirection: 'row', alignItems: 'center' },
  icon: { width: 46, height: 46, borderRadius: 14, backgroundColor: '#FFF0DE', alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, marginLeft: 13 }, name: { color: colors.ink, fontSize: 16, fontWeight: '800' }, count: { color: colors.muted, fontSize: 12, marginTop: 3 },
});
