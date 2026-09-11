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
    <Tabs.Screen name="alerts" options={{ title: 'Deal Alerts', tabBarLabel: 'Alerts', tabBarIcon: ({ color, size }) => <Ionicons name="notifications" color={color} size={size} /> }} />
    <Tabs.Screen name="submit" options={{ title: 'Submit a Deal', tabBarLabel: 'Submit', tabBarIcon: ({ color, size }) => <Ionicons name="add-circle" color={color} size={size} /> }} />
    <Tabs.Screen name="review" options={{ href: null }} />
    <Tabs.Screen name="favorites" options={{ title: 'Favorites', tabBarIcon: ({ color, size }) => <Ionicons name="heart" color={color} size={size} /> }} />
    <Tabs.Screen name="profile" options={{ title: 'Profile & About', tabBarLabel: 'Profile', tabBarIcon: ({ color, size }) => <Ionicons name="person-circle" color={color} size={size} /> }} />
  </Tabs>;
}
