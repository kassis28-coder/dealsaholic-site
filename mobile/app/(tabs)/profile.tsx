import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';
import { useProfile } from '@/context/profile-context';

const publicLinks = [
  { title: 'Affiliate Disclosure', subtitle: 'Amazon, Walmart and other affiliate relationships', icon: 'document-text', action: () => router.push('/disclosure' as never) },
  { title: 'Privacy Policy', subtitle: 'How Deals-aholic handles information', icon: 'shield-checkmark', action: () => Linking.openURL('https://deals-aholic.com/privacy.html') },
  { title: 'About Deals-aholic', subtitle: 'Learn more about our deal community', icon: 'information-circle', action: () => Linking.openURL('https://deals-aholic.com/about.html') },
  { title: 'Contact Deals-aholic', subtitle: 'dealsaholic1@gmail.com', icon: 'mail', action: () => Linking.openURL('mailto:dealsaholic1@gmail.com') },
] as const;

export default function ProfileScreen() {
  const { profile, signOut } = useProfile();
  return <ScrollView contentContainerStyle={styles.content}>
    <Pressable style={styles.hero} delayLongPress={1500} onLongPress={() => router.push('/review' as never)}><View style={styles.logo}><Ionicons name="flame" size={34} color={colors.orange} /></View><Text style={styles.title}>Deals-aholic</Text><Text style={styles.subtitle}>{profile ? `Community profile: ${profile.name}` : 'Browse deals freely or join the community.'}</Text></Pressable>
    <Pressable style={styles.community} onPress={() => profile ? signOut() : router.push('/community-profile' as never)}><Ionicons name={profile ? 'log-out-outline' : 'people'} size={21} color={profile ? colors.red : colors.orangeDark} /><View style={styles.rowCopy}><Text style={styles.rowTitle}>{profile ? 'Leave community profile' : 'Join the community'}</Text><Text style={styles.rowSubtitle}>{profile ? 'Use a different name or continue as a guest' : 'React, comment, reply, and share savings tips'}</Text></View><Ionicons name="chevron-forward" size={20} color={colors.muted} /></Pressable>
    <View style={styles.card}>{publicLinks.map((item) => <Pressable key={item.title} style={styles.row} onPress={item.action}>
      <View style={styles.icon}><Ionicons name={item.icon} size={22} color={colors.orangeDark} /></View><View style={styles.rowCopy}><Text style={styles.rowTitle}>{item.title}</Text><Text style={styles.rowSubtitle}>{item.subtitle}</Text></View><Ionicons name="chevron-forward" size={20} color={colors.muted} />
    </Pressable>)}</View>
    <Text style={styles.footer}>As an Amazon Associate, Deals-aholic earns from qualifying purchases.</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { padding: 18, paddingBottom: 40, backgroundColor: colors.cream, flexGrow: 1 },
  hero: { alignItems: 'center', paddingVertical: 24 }, logo: { width: 68, height: 68, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF3E0' },
  title: { color: colors.ink, fontSize: 28, fontWeight: '900', marginTop: 13 }, subtitle: { color: colors.muted, textAlign: 'center', fontSize: 14, marginTop: 5 },
  card: { backgroundColor: colors.card, borderRadius: 18, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  community: { backgroundColor: '#FFF3E0', borderRadius: 18, borderWidth: 1, borderColor: '#FFD6A5', flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, marginBottom: 13 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  icon: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFF3E0', alignItems: 'center', justifyContent: 'center' }, rowCopy: { flex: 1 }, rowTitle: { color: colors.ink, fontSize: 15, fontWeight: '900' }, rowSubtitle: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  footer: { color: colors.muted, textAlign: 'center', fontSize: 11, lineHeight: 16, marginTop: 26 },
});
