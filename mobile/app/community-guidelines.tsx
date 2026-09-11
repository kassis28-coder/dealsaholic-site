import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';

const rules = [
  ['Be helpful', 'Share real savings tips, product experiences, and respectful replies.'],
  ['No spam or scams', 'Do not post referral spam, misleading links, repeated messages, or solicitations.'],
  ['Keep it respectful', 'No harassment, hate, threats, adult content, or personal attacks.'],
  ['Report concerns', 'Use Report on any comment that breaks these rules. Reported comments are removed from public view while reviewed.'],
];

export default function CommunityGuidelinesScreen() {
  return <ScrollView contentContainerStyle={styles.content}><Text style={styles.title}>Community guidelines</Text><Text style={styles.intro}>Deals‑Aholic is a place for shoppers to help one another save. These rules apply to comments and replies.</Text>{rules.map(([title, copy]) => <View key={title} style={styles.rule}><Text style={styles.ruleTitle}>{title}</Text><Text style={styles.copy}>{copy}</Text></View>)}<Text style={styles.footer}>We may remove content or restrict profiles that do not follow these guidelines.</Text></ScrollView>;
}
const styles = StyleSheet.create({ content: { padding: 20, paddingBottom: 45, backgroundColor: colors.cream }, title: { color: colors.ink, fontSize: 29, fontWeight: '900' }, intro: { color: colors.muted, fontSize: 15, lineHeight: 23, marginTop: 10 }, rule: { marginTop: 24, padding: 17, backgroundColor: colors.card, borderRadius: 15, borderWidth: 1, borderColor: colors.line }, ruleTitle: { color: colors.ink, fontSize: 17, fontWeight: '900' }, copy: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 }, footer: { color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 28 } });
