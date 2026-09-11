import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { ScreenState } from '@/components/screen-state';
import { colors } from '@/constants/colors';
import { useDeals } from '@/context/deals-context';
import { CommunityPanel } from '@/components/community-panel';
import { openAffiliateDeal } from '@/services/deals';
import { retailerName, shareUrl } from '@/types/deal';

export default function DealDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { findDeal, isFavorite, toggleFavorite } = useDeals();
  const [opening, setOpening] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reported, setReported] = useState(false);
  const deal = findDeal(decodeURIComponent(id || ''));
  if (!deal) return <ScreenState title="Deal unavailable" message="This deal may have expired. Return to the feed and refresh." />;

  const retailer = retailerName(deal);
  const buy = async () => {
    setOpening(true);
    try { await openAffiliateDeal(deal); } finally { setOpening(false); }
  };

  const reportExpiredCode = () => Alert.alert(
    'Report expired promo code?',
    'This sends the deal to Deals-aholic for review.',
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Report', style: 'destructive', onPress: async () => {
        setReporting(true);
        try {
          const dealId = deal.id || deal.asin;
          if (!dealId || !deal.discountCode) throw new Error('This deal cannot be reported automatically.');
          const source = String(deal.source || '').toLowerCase();
          const dealSource = source === 'amazon' || (!deal.id && !!deal.asin) ? 'amazon' : 'submission';
          const response = await fetch('https://deals-aholic.com/api/flag-deal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dealId, dealSource, code: deal.discountCode, productUrl: deal.url }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || 'The report could not be sent.');
          if (data.action === 'ignored') {
            Alert.alert('Code still detected', 'The retailer still appears to show this promo code, so the deal was not removed.');
          } else {
            setReported(true);
            Alert.alert('Report received', 'The deal was sent to the Deals-aholic review queue. Thank you.');
          }
        } catch (error) {
          Alert.alert('Could not send report', error instanceof Error ? error.message : 'Please try again.');
        } finally {
          setReporting(false);
        }
      } },
    ],
  );

  return <ScrollView contentContainerStyle={styles.content}>
    <Stack.Screen options={{ title: retailer }} />
    <View style={styles.imageWrap}>{deal.image ? <Image source={{ uri: deal.image }} style={styles.image} contentFit="contain" /> : <Ionicons name="image-outline" size={64} color={colors.line} />}</View>
    <View style={styles.topline}><Text style={styles.retailer}>{retailer}</Text>{!!deal.discountPercent && <Text style={styles.discount}>{deal.discountPercent}% OFF</Text>}</View>
    <Text style={styles.title}>{deal.title}</Text>
    <View style={styles.priceRow}><Text style={styles.price}>{String(deal.price || 'See retailer')}</Text>{!!deal.originalPrice && <Text style={styles.original}>{String(deal.originalPrice)}</Text>}</View>
    {!!deal.discountCode && <Pressable style={styles.code} onPress={async () => { await Clipboard.setStringAsync(deal.discountCode!); Alert.alert('Promo code copied', deal.discountCode!); }}>
      <Text style={styles.codeLabel}>PROMO CODE</Text><Text style={styles.codeValue}>{deal.discountCode}</Text><Text style={styles.codeHelp}>Tap to copy</Text>
    </Pressable>}
    {!!deal.discountCode && <Pressable disabled={reporting || reported} style={styles.reportCode} onPress={reportExpiredCode}>
      <Ionicons name={reported ? 'checkmark-circle' : 'warning-outline'} size={16} color={reported ? colors.green : colors.red} />
      <Text style={[styles.reportCodeText, reported && styles.reportedText]}>{reported ? 'Sent for review' : reporting ? 'Sending report…' : 'Report expired code'}</Text>
    </Pressable>}
    <Pressable style={styles.buy} onPress={buy} disabled={opening}><Text style={styles.buyText}>{opening ? 'Opening deal…' : `Shop at ${retailer}`}</Text></Pressable>
    <Text style={styles.commissionNotice}>Deals-aholic may earn a commission if you purchase through this link, at no additional cost to you.</Text>
    <View style={styles.secondary}>
      <Pressable style={styles.secondaryButton} onPress={() => toggleFavorite(deal)}><Ionicons name={isFavorite(deal) ? 'heart' : 'heart-outline'} size={21} color={colors.red} /><Text style={styles.secondaryText}>{isFavorite(deal) ? 'Saved' : 'Save'}</Text></Pressable>
      <Pressable style={styles.secondaryButton} onPress={() => Share.share({ message: `Check out this deal: ${shareUrl(deal)}`, url: shareUrl(deal) })}><Ionicons name="share-outline" size={21} color={colors.orangeDark} /><Text style={styles.secondaryText}>Share</Text></Pressable>
    </View>
    <CommunityPanel dealId={String(deal.id || deal.asin || deal.url)} />
    <Text style={styles.disclaimer}>Prices and availability may change. Deals-aholic may earn a commission from qualifying purchases.</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { padding: 18, paddingBottom: 40, backgroundColor: colors.cream },
  imageWrap: { height: 350, backgroundColor: '#fff', borderRadius: 22, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  image: { width: '100%', height: '100%' },
  topline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 },
  retailer: { color: colors.orangeDark, fontSize: 13, fontWeight: '900', textTransform: 'uppercase' },
  discount: { color: '#fff', backgroundColor: colors.green, borderRadius: 16, overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 6, fontSize: 12, fontWeight: '900' },
  title: { color: colors.ink, fontSize: 23, lineHeight: 30, fontWeight: '900', marginTop: 10 },
  priceRow: { flexDirection: 'row', gap: 12, alignItems: 'baseline', marginVertical: 16 },
  price: { color: colors.ink, fontSize: 31, fontWeight: '900' }, original: { color: colors.muted, textDecorationLine: 'line-through', fontSize: 17 },
  code: { backgroundColor: '#FFF2E1', borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.orange, borderRadius: 14, padding: 15, alignItems: 'center', marginBottom: 15 },
  codeLabel: { color: colors.orangeDark, fontSize: 11, fontWeight: '900' }, codeValue: { color: colors.ink, fontSize: 22, fontWeight: '900', letterSpacing: 1.4, marginTop: 4 }, codeHelp: { color: colors.muted, fontSize: 11, marginTop: 3 },
  reportCode: { minHeight: 38, marginTop: -7, marginBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  reportCodeText: { color: colors.red, fontSize: 12, fontWeight: '800' }, reportedText: { color: colors.green },
  buy: { backgroundColor: colors.orange, borderRadius: 15, minHeight: 56, alignItems: 'center', justifyContent: 'center' }, buyText: { color: '#fff', fontSize: 17, fontWeight: '900' },
  commissionNotice: { color: colors.muted, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 8 },
  secondary: { flexDirection: 'row', gap: 10, marginTop: 11 }, secondaryButton: { flex: 1, flexDirection: 'row', gap: 7, justifyContent: 'center', alignItems: 'center', minHeight: 48, backgroundColor: colors.card, borderRadius: 14, borderWidth: 1, borderColor: colors.line }, secondaryText: { color: colors.ink, fontWeight: '800' },
  disclaimer: { color: colors.muted, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 24 },
});
