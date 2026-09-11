import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/colors';

const EMPTY_FORM = {
  title: '', url: '', photoUrl: '', price: '', originalPrice: '', discount: '', discountCode: '', expiresOn: '',
};

export default function ReviewScreen() {
  const [password, setPassword] = useState('');
  const [form, setForm] = useState(EMPTY_FORM);
  const [posting, setPosting] = useState(false);

  const update = (field: keyof typeof EMPTY_FORM, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const createDeal = async () => {
    if (!password.trim()) return Alert.alert('Administrator password required', 'Enter your Deals-aholic administrator password.');
    if (!form.title.trim() || !form.url.trim() || !form.price.trim()) return Alert.alert('Missing information', 'Title, product URL, and current price are required.');
    setPosting(true);
    try {
      const response = await fetch('https://deals-aholic.com/api/admin-create-deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.trim(), ...form }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'The deal could not be posted.');
      setForm(EMPTY_FORM);
      Alert.alert('Deal posted', 'The new deal was added successfully. Pull down on the Deals page to refresh it.');
    } catch (error) {
      Alert.alert('Could not post deal', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setPosting(false);
    }
  };

  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <View style={styles.header}>
      <View style={styles.lock}><Ionicons name="lock-closed" size={24} color={colors.orange} /></View>
      <View style={styles.headerCopy}><Text style={styles.title}>Owner tools</Text><Text style={styles.copy}>Private administrator access for reviewing submissions and manually adding deals.</Text></View>
    </View>

    <Text style={styles.sectionTitle}>Manually add a deal</Text>
    <View style={styles.formCard}>
      <Field label="Administrator password *" value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry />
      <Field label="Deal title *" value={form.title} onChangeText={(value) => update('title', value)} placeholder="Product title" multiline />
      <Field label="Product URL *" value={form.url} onChangeText={(value) => update('url', value)} placeholder="https://…" autoCapitalize="none" keyboardType="url" />
      <Field label="Image URL" value={form.photoUrl} onChangeText={(value) => update('photoUrl', value)} placeholder="Leave blank to fetch automatically" autoCapitalize="none" keyboardType="url" />
      <View style={styles.row}>
        <View style={styles.half}><Field label="Current price *" value={form.price} onChangeText={(value) => update('price', value)} placeholder="$19.99" keyboardType="decimal-pad" /></View>
        <View style={styles.half}><Field label="Original price" value={form.originalPrice} onChangeText={(value) => update('originalPrice', value)} placeholder="$39.99" keyboardType="decimal-pad" /></View>
      </View>
      <View style={styles.row}>
        <View style={styles.half}><Field label="Discount %" value={form.discount} onChangeText={(value) => update('discount', value)} placeholder="50" keyboardType="number-pad" /></View>
        <View style={styles.half}><Field label="Promo code" value={form.discountCode} onChangeText={(value) => update('discountCode', value)} placeholder="SAVE20" autoCapitalize="characters" /></View>
      </View>
      <Field label="Expiration date" value={form.expiresOn} onChangeText={(value) => update('expiresOn', value)} placeholder="YYYY-MM-DD" autoCapitalize="none" />
      <Pressable disabled={posting} style={[styles.postButton, posting && styles.disabled]} onPress={createDeal}>
        {posting ? <ActivityIndicator color="#fff" /> : <><Ionicons name="cloud-upload" size={18} color="#fff" /><Text style={styles.postButtonText}>Post deal now</Text></>}
      </Pressable>
    </View>

    <Text style={styles.sectionTitle}>Submission review</Text>
    <Text style={styles.reviewCopy}>Open the complete owner dashboard to approve, reject, edit, or delete pending submissions.</Text>
    <Pressable style={styles.dashboardButton} onPress={() => WebBrowser.openBrowserAsync('https://deals-aholic.com/admin.html')}>
      <Text style={styles.dashboardButtonText}>Open review dashboard</Text><Ionicons name="open-outline" size={18} color="#fff" />
    </Pressable>
  </ScrollView>;
}

function Field({ label, multiline, ...props }: { label: string; multiline?: boolean } & React.ComponentProps<typeof TextInput>) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput {...props} multiline={multiline} placeholderTextColor={colors.muted} style={[styles.input, multiline && styles.multiline]} /></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  content: { padding: 18, paddingBottom: 50 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 24 },
  lock: { width: 50, height: 50, borderRadius: 18, backgroundColor: '#FFF1E5', alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1 }, title: { color: colors.ink, fontSize: 27, fontWeight: '900' },
  copy: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: '900', marginBottom: 10 },
  formCard: { backgroundColor: colors.card, borderRadius: 18, borderWidth: 1, borderColor: colors.line, padding: 15, marginBottom: 28 },
  field: { marginBottom: 13 }, label: { color: colors.ink, fontSize: 12, fontWeight: '800', marginBottom: 6 },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.line, borderRadius: 11, backgroundColor: colors.cream, paddingHorizontal: 12, color: colors.ink, fontSize: 14 },
  multiline: { minHeight: 78, paddingTop: 12, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10 }, half: { flex: 1 },
  postButton: { minHeight: 50, borderRadius: 13, backgroundColor: colors.orange, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 3 },
  postButtonText: { color: '#fff', fontSize: 15, fontWeight: '900' }, disabled: { opacity: 0.65 },
  reviewCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: 13 },
  dashboardButton: { minHeight: 50, borderRadius: 13, backgroundColor: colors.ink, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dashboardButtonText: { color: '#fff', fontSize: 14, fontWeight: '900' },
});
