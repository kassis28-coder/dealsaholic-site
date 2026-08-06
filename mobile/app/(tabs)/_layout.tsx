import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { colors } from '@/constants/colors';

export default function TabsLayout() {
  return <Tabs screenOptions={{
    headerStyle: { backgroundColor: colors.card },
    headerTitleStyle: { fontWeight: '900', color: colors.ink },
    tabBarActiveTintColor: colors.orange,
    tabBarInactiveTintColor: colors.muted,
    tabBarStyle: { borderTopColor: colors.line, backgroundColor: colors.card },
  }}>
    <Tabs.Screen name="index" options={{ title: 'Deals-aholic', tabBarLabel: 'Deals', tabBarIcon: ({ color, size }) => <Ionicons name="flame" color={color} size={size} /> }} />
    <Tabs.Screen name="retailers" options={{ title: 'Retailers', tabBarIcon: ({ color, size }) => <Ionicons name="storefront" color={color} size={size} /> }} />
    <Tabs.Screen name="favorites" options={{ title: 'Favorites', tabBarIcon: ({ color, size }) => <Ionicons name="heart" color={color} size={size} /> }} />
  </Tabs>;
}
