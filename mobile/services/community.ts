import { CommunityData, CommunityProfile } from '@/types/community';

const API_BASE = 'https://deals-aholic.com';

async function request(dealId: string, body?: Record<string, unknown>): Promise<CommunityData> {
  const url = `${API_BASE}/api/community?dealId=${encodeURIComponent(dealId)}`;
  const response = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'Community activity could not be saved.');
  return payload as CommunityData;
}

export const getCommunity = (dealId: string) => request(dealId);
export const reactToDeal = (dealId: string, profile: CommunityProfile, reaction: string) => request(dealId, { action: 'reaction', profile, reaction });
export const addComment = (dealId: string, profile: CommunityProfile, text: string, parentId?: string | null) => request(dealId, { action: 'comment', profile, text, parentId: parentId || null, acceptedGuidelines: true });
export const reportComment = (dealId: string, profile: CommunityProfile, commentId: string) => request(dealId, { action: 'report', profile, commentId, reason: 'Reported from the app' });
