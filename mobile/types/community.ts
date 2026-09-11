export type CommunityProfile = { id: string; name: string; type: 'guest' | 'member' };
export type CommunityComment = { id: string; parentId: string | null; author: CommunityProfile; text: string; createdAt: string };
export type CommunityData = { reactionCounts: Record<string, number>; comments: CommunityComment[] };
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '👎'] as const;
