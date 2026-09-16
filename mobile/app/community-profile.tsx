import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useProfile } from '@/context/profile-context';
import { colors } from '@/constants/colors';

export default function CommunityProfileScreen() {
  const { createProfile, continueAsGuest } = useProfile();
  const [name, setName] = useState('');
  const [acceptedGuidelines, setAcceptedGuidelines] = useState(false);
  const join = async () => {
    if (!acceptedGuidelines) return Alert.alert('Community guidelines required', 'Please confirm that you agree to the community guidelines before creating a profile.');
    if (name.trim().length < 2) return Alert.alert('Choose a display name', 'Please enter at least 2 characters.');
    await createProfile(name);
    router.back();
  };
  const guest = async () => {
    if (!acceptedGuidelines) return Alert.alert('Community guidelines required', 'Please confirm that you agree to the community guidelines before continuing as a guest.');
    await continueAsGuest();
    router.back();
  };
  return <View style={styles.screen}>
    <Text style={styles.title}>Join the deal community</Text>
    <Text style={styles.copy}>Create a free display name to react, comment, reply, and share your savings tips. Your display name is visible to other members.</Text>
    <Text style={styles.label}>DISPLAY NAME</Text>
    <TextInput value={name} onChangeText={setName} placeholder="For example, SavingsFan" placeholderTextColor={colors.muted} maxLength={30} style={styles.input} autoCapitalize="words" />
    <Pressable style={[styles.guidelineCheck, acceptedGuidelines && styles.guidelineCheckActive]} onPress={() => setAcceptedGuidelines((value) => !value)} accessibilityRole="checkbox" accessibilityState={{ checked: acceptedGuidelines }}>
      <View style={[styles.checkbox, acceptedGuidelines && styles.checkboxActive]}>{acceptedGuidelines && <Text style={styles.checkmark}>✓</Text>}</View>
      <Text style={styles.checkCopy}>I agree to the Community Guidelines and will not post spam, scams, harassment, or offensive content.</Text>
    </Pressable>
    <Pressable style={[styles.primary, !acceptedGuidelines && styles.disabled]} onPress={join}><Text style={styles.primaryText}>Create free profile</Text></Pressable>
    <Pressable style={[styles.guest, !acceptedGuidelines && styles.disabled]} onPress={guest}><Text style={styles.guestText}>Continue as guest</Text></Pressable>
    <Text style={styles.note}>You must accept the guidelines before you can react, comment, or reply. Display names and community posts are visible to other members.</Text>
    <Pressable onPress={() => router.push('/community-guidelines' as never)}><Text style={styles.link}>Read community guidelines</Text></Pressable>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 22, backgroundColor: colors.cream }, title: { color: colors.ink, fontSize: 29, fontWeight: '900' }, copy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 10 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '900', letterSpacing: 0.8, marginTop: 28, marginBottom: 8 }, input: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: 14, minHeight: 53, paddingHorizontal: 15, color: colors.ink, fontSize: 16 },
  guidelineCheck: { marginTop: 21, padding: 13, borderRadius: 13, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, flexDirection: 'row', gap: 10, alignItems: 'flex-start' }, guidelineCheckActive: { borderColor: '#F5B768', backgroundColor: '#FFF8EE' }, checkbox: { width: 21, height: 21, borderRadius: 6, borderWidth: 2, borderColor: colors.orangeDark, alignItems: 'center', justifyContent: 'center', marginTop: 1 }, checkboxActive: { backgroundColor: colors.orangeDark }, checkmark: { color: '#fff', fontWeight: '900', fontSize: 14 }, checkCopy: { color: colors.ink, flex: 1, fontSize: 12, fontWeight: '700', lineHeight: 18 },
  primary: { minHeight: 54, marginTop: 14, borderRadius: 14, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.orange }, primaryText: { color: '#fff', fontSize: 16, fontWeight: '900' }, disabled: { opacity: 0.5 },
  guest: { minHeight: 50, marginTop: 7, justifyContent: 'center', alignItems: 'center' }, guestText: { color: colors.orangeDark, fontSize: 15, fontWeight: '900' }, note: { color: colors.muted, lineHeight: 18, fontSize: 11, textAlign: 'center', marginTop: 20 }, link: { color: colors.orangeDark, fontWeight: '900', textAlign: 'center', marginTop: 14 },
});
