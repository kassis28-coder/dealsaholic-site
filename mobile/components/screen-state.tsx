import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { colors } from '@/constants/colors';

export function ScreenState({ title, message, loading = false }: { title: string; message?: string; loading?: boolean }) {
  return <View style={styles.wrap}>
    {loading && <ActivityIndicator size="large" color={colors.orange} />}
    <Text style={styles.title}>{title}</Text>
    {!!message && <Text style={styles.message}>{message}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  title: { marginTop: 14, color: colors.ink, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  message: { marginTop: 7, color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
});
