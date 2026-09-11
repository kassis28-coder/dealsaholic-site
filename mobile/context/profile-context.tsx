import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CommunityProfile } from '@/types/community';

const KEY = 'deals-aholic:community-profile';
type ProfileContextValue = { profile: CommunityProfile | null; ready: boolean; continueAsGuest: () => Promise<void>; createProfile: (name: string) => Promise<void>; signOut: () => Promise<void> };
const ProfileContext = createContext<ProfileContextValue | null>(null);

const newId = () => `member-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function ProfileProvider({ children }: PropsWithChildren) {
  const [profile, setProfile] = useState<CommunityProfile | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => { AsyncStorage.getItem(KEY).then((stored) => stored && setProfile(JSON.parse(stored))).catch(() => undefined).finally(() => setReady(true)); }, []);
  const save = useCallback(async (next: CommunityProfile) => { setProfile(next); await AsyncStorage.setItem(KEY, JSON.stringify(next)); }, []);
  const continueAsGuest = useCallback(() => save({ id: newId(), name: 'Deal Hunter', type: 'guest' }), [save]);
  const createProfile = useCallback((name: string) => save({ id: newId(), name: name.trim().slice(0, 30), type: 'member' }), [save]);
  const signOut = useCallback(async () => { setProfile(null); await AsyncStorage.removeItem(KEY); }, []);
  const value = useMemo(() => ({ profile, ready, continueAsGuest, createProfile, signOut }), [profile, ready, continueAsGuest, createProfile, signOut]);
  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfile() { const value = useContext(ProfileContext); if (!value) throw new Error('useProfile must be used inside ProfileProvider'); return value; }
