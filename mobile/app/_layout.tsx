import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { DealsProvider } from '@/context/deals-context';
import { colors } from '@/constants/colors';

export default function RootLayout() {
  return <DealsProvider>
    <StatusBar style="dark" />
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.ink, contentStyle: { backgroundColor: colors.cream } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="deal/[id]" options={{ title: 'Deal details', headerBackTitle: 'Deals' }} />
    </Stack>
  </DealsProvider>;
}
