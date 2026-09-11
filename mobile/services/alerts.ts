import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { CommunityProfile } from '@/types/community';

const API_BASE = 'https://deals-aholic.com';

export async function getPushToken() {
  if (!Device.isDevice) throw new Error('Alerts need a physical phone.');
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('deal-alerts', { name: 'Deal alerts', importance: Notifications.AndroidImportance.HIGH, vibrationPattern: [0, 250, 250, 250] });
  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === 'granted' ? current : await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Allow notifications in your phone settings to receive deal alerts.');
  const projectId = Constants.expoConfig?.extra?.eas?.projectId || Constants.easConfig?.projectId;
  if (!projectId) throw new Error('Notification setup is unavailable.');
  return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
}

export async function saveAlertPreferences(profile: CommunityProfile, token: string, keywords: string[], categories: string[]) {
  const response = await fetch(`${API_BASE}/api/deal-alerts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', profile, token, keywords, categories }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Could not save deal alerts.');
}

export async function disableAlerts(profile: CommunityProfile) {
  await fetch(`${API_BASE}/api/deal-alerts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'disable', profile }) });
}
