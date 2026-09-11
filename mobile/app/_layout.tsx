import { Stack } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { DealsProvider } from '@/context/deals-context';
import { ProfileProvider } from '@/context/profile-context';
import { colors } from '@/constants/colors';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }) });

export default function RootLayout() {
  return <ProfileProvider><DealsProvider>
    <StatusBar style="dark" />
    <Stack screenOptions={{ headerStyle: { backgroundColor: colors.card }, headerTintColor: colors.ink, contentStyle: { backgroundColor: colors.cream } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="deal/[id]" options={{ title: 'Deal details', headerBackTitle: 'Deals' }} />
      <Stack.Screen name="disclosure" options={{ title: 'Affiliate Disclosure', headerBackTitle: 'Profile' }} />
      <Stack.Screen name="community-profile" options={{ title: 'Join the community', presentation: 'modal' }} />
      <Stack.Screen name="community-guidelines" options={{ title: 'Community guidelines' }} />
    </Stack>
  </DealsProvider></ProfileProvider>;
}
