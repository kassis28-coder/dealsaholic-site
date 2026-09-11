import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';

export default function SubmitDealScreen() {
  return <View style={styles.screen}>
    <View style={styles.card}>
      <View style={styles.icon}><Ionicons name="pricetag" size={32} color={colors.orange} /></View>
      <Text style={styles.title}>Submit a deal</Text>
      <Text style={styles.copy}>Add a deal from Amazon or another online retailer. Submissions continue through the website’s existing payment, duplicate-checking, and manual-review process.</Text>
      <Pressable style={styles.button} onPress={() => WebBrowser.openBrowserAsync('https://deals-aholic.com/submit.html')}>
        <Text style={styles.buttonText}>Open submission form</Text><Ionicons name="open-outline" size={18} color="#fff" />
      </Pressable>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream, padding: 18, justifyContent: 'center' },
  card: { backgroundColor: colors.card, borderRadius: 22, padding: 24, borderWidth: 1, borderColor: colors.line },
  icon: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#FFF1E5', alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  title: { color: colors.ink, fontSize: 27, fontWeight: '900' },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 10, marginBottom: 22 },
  button: { backgroundColor: colors.orange, borderRadius: 14, padding: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '900' },
});
