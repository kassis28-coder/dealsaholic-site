import { Stack } from 'expo-router';
import * as Linking from 'expo-linking';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';

export default function DisclosureScreen() {
  return <ScrollView contentContainerStyle={styles.content}>
    <Stack.Screen options={{ title: 'Affiliate Disclosure' }} />
    <Text style={styles.title}>Disclaimer and Affiliate Disclosure</Text>
    <Text style={styles.updated}>Deals-aholic · Last updated August 2026</Text>
    <Section title="Amazon Associates Program">
      As an Amazon Associate, Deals-aholic earns from qualifying purchases. When you use an eligible Amazon link in this app and complete a qualifying purchase, Deals-aholic may receive a commission at no additional cost to you.
    </Section>
    <Section title="Walmart Affiliate Program">
      Deals-aholic participates in affiliate advertising for Walmart through Impact and may receive referral fees from qualifying purchases made through eligible Walmart links, at no additional cost to you.
    </Section>
    <Section title="Other affiliate programs">
      Deals-aholic may use affiliate links supplied by JoyLink, BrandCycle, Mavely, Impact and other retailer or affiliate networks. We may earn a commission when a qualifying purchase is completed through these links.
    </Section>
    <Section title="Prices, promotions and availability">
      Prices, discounts, promotional codes and product availability are accurate to the best of our knowledge when posted, but retailers may change or end them at any time. Always confirm the final price, terms and product details on the retailer’s checkout page before purchasing.
    </Section>
    <Section title="Advertising transparency">
      Affiliate compensation does not increase the price you pay. External retailers control their products, transactions, fulfillment, returns and customer service. A link does not mean that the retailer sponsors or endorses Deals-aholic.
    </Section>
    <Pressable style={styles.contact} onPress={() => Linking.openURL('mailto:dealsaholic1@gmail.com?subject=Affiliate%20Disclosure%20Question')}>
      <Text style={styles.contactText}>Questions? Click here to contact Deals-aholic.</Text>
    </Pressable>
  </ScrollView>;
}

function Section({ title, children }: { title: string; children: string }) {
  return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><Text style={styles.body}>{children}</Text></View>;
}

const styles = StyleSheet.create({
  content: { padding: 20, paddingBottom: 48, backgroundColor: colors.cream }, title: { color: colors.ink, fontSize: 30, lineHeight: 36, fontWeight: '900' }, updated: { color: colors.muted, fontSize: 12, marginTop: 8, marginBottom: 8 }, section: { marginTop: 25 }, sectionTitle: { color: colors.ink, fontSize: 21, lineHeight: 27, fontWeight: '900' }, body: { color: colors.muted, fontSize: 15, lineHeight: 24, marginTop: 9 },
  contact: { marginTop: 30, padding: 16, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14 },
  contactText: { color: colors.orangeDark, textAlign: 'center', fontSize: 14, fontWeight: '900' },
});
