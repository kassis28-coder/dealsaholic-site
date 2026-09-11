import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/colors';
import { useProfile } from '@/context/profile-context';
import { addComment, getCommunity, reactToDeal, reportComment } from '@/services/community';
import { CommunityComment, CommunityData, REACTIONS } from '@/types/community';

const blockedKey = 'deals-aholic:blocked-community-members';

export function CommunityPanel({ dealId }: { dealId: string }) {
  const { profile } = useProfile();
  const [community, setCommunity] = useState<CommunityData>({ reactionCounts: {}, comments: [] });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [text, setText] = useState('');
  const [replyingTo, setReplyingTo] = useState<CommunityComment | null>(null);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());

  const load = useCallback(async () => { try { setCommunity(await getCommunity(dealId)); } catch { /* Empty state is still useful offline. */ } finally { setLoading(false); } }, [dealId]);
  useEffect(() => { load(); AsyncStorage.getItem(blockedKey).then((value) => value && setBlocked(new Set(JSON.parse(value)))).catch(() => undefined); }, [load]);
  const comments = useMemo(() => community.comments.filter((comment) => !blocked.has(comment.author.id)), [blocked, community.comments]);
  const roots = comments.filter((comment) => !comment.parentId);
  const needProfile = () => { if (!profile) { Alert.alert('Join the community', 'Create a free profile or continue as a guest to react and comment.', [{ text: 'Not now', style: 'cancel' }, { text: 'Join', onPress: () => router.push('/community-profile' as never) }]); return true; } return false; };
  const react = async (emoji: string) => { if (needProfile()) return; setWorking(true); try { setCommunity(await reactToDeal(dealId, profile!, emoji)); } catch (error) { Alert.alert('Could not save reaction', error instanceof Error ? error.message : 'Please try again.'); } finally { setWorking(false); } };
  const post = async () => { if (needProfile() || !text.trim()) return; setWorking(true); try { setCommunity(await addComment(dealId, profile!, text, replyingTo?.id)); setText(''); setReplyingTo(null); } catch (error) { Alert.alert('Could not post comment', error instanceof Error ? error.message : 'Please try again.'); } finally { setWorking(false); } };
  const report = (comment: CommunityComment) => { if (needProfile()) return; Alert.alert('Report comment?', 'The comment will be hidden while Deals‑Aholic reviews it.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Report', style: 'destructive', onPress: async () => { try { setCommunity(await reportComment(dealId, profile!, comment.id)); } catch { Alert.alert('Could not send report', 'Please try again.'); } } }]); };
  const block = async (authorId: string) => { const next = new Set(blocked); next.add(authorId); setBlocked(next); await AsyncStorage.setItem(blockedKey, JSON.stringify([...next])); };

  return <View style={styles.section}>
    <View style={styles.titleRow}><View><Text style={styles.title}>Deal community</Text><Text style={styles.subtitle}>Ask questions, share tips, and help others save.</Text></View><Pressable onPress={() => router.push('/community-guidelines' as never)}><Text style={styles.guidelines}>Guidelines</Text></Pressable></View>
    <View style={styles.reactions}>{REACTIONS.map((emoji) => <Pressable disabled={working} key={emoji} style={styles.reaction} onPress={() => react(emoji)}><Text style={styles.emoji}>{emoji}</Text><Text style={styles.reactionCount}>{community.reactionCounts[emoji] || 0}</Text></Pressable>)}</View>
    {!profile && <Pressable style={styles.join} onPress={() => router.push('/community-profile' as never)}><Ionicons name="people-outline" size={19} color={colors.orangeDark} /><Text style={styles.joinText}>Join or continue as guest to react and comment</Text><Ionicons name="chevron-forward" size={17} color={colors.orangeDark} /></Pressable>}
    <View style={styles.composer}><Text style={styles.composerLabel}>{replyingTo ? `Replying to ${replyingTo.author.name}` : 'Join the conversation'}</Text><TextInput value={text} onChangeText={setText} multiline maxLength={500} placeholder={profile ? 'Share a helpful deal tip…' : 'Join the community to comment'} placeholderTextColor={colors.muted} editable={!!profile && !working} style={styles.input} /><View style={styles.composerActions}>{replyingTo ? <Pressable onPress={() => setReplyingTo(null)}><Text style={styles.cancel}>Cancel reply</Text></Pressable> : <Text style={styles.characterCount}>{text.length}/500</Text>}<Pressable style={[styles.post, (!text.trim() || !profile || working) && styles.postDisabled]} disabled={!text.trim() || !profile || working} onPress={post}><Text style={styles.postText}>{working ? 'Posting…' : 'Post'}</Text></Pressable></View></View>
    {loading ? <ActivityIndicator color={colors.orange} style={styles.loader} /> : roots.length ? <View style={styles.thread}>{roots.map((comment) => <Comment key={comment.id} comment={comment} replies={comments.filter((entry) => entry.parentId === comment.id)} onReply={(target) => { setReplyingTo(target); setText(''); }} onReport={report} onBlock={(target) => block(target.author.id)} />)}</View> : <Text style={styles.empty}>Be the first to share a helpful tip about this deal.</Text>}
  </View>;
}

function Comment({ comment, replies, onReply, onReport, onBlock }: { comment: CommunityComment; replies: CommunityComment[]; onReply: (comment: CommunityComment) => void; onReport: (comment: CommunityComment) => void; onBlock: (comment: CommunityComment) => void }) {
  return <View style={styles.comment}><View style={styles.avatar}><Text style={styles.avatarText}>{comment.author.name.slice(0, 1).toUpperCase()}</Text></View><View style={styles.commentBody}><View style={styles.commentMeta}><Text style={styles.author}>{comment.author.name}</Text><Text style={styles.time}>{new Date(comment.createdAt).toLocaleDateString()}</Text></View><Text style={styles.commentText}>{comment.text}</Text><CommentActions comment={comment} onReply={onReply} onReport={onReport} onBlock={onBlock} />{replies.map((reply) => <View key={reply.id} style={styles.reply}><Text style={styles.replyAuthor}>{reply.author.name}</Text><Text style={styles.commentText}>{reply.text}</Text><CommentActions comment={reply} onReply={onReply} onReport={onReport} onBlock={onBlock} canReply={false} /></View>)}</View></View>;
}

function CommentActions({ comment, onReply, onReport, onBlock, canReply = true }: { comment: CommunityComment; onReply: (comment: CommunityComment) => void; onReport: (comment: CommunityComment) => void; onBlock: (comment: CommunityComment) => void; canReply?: boolean }) {
  return <View style={styles.commentActions}>{canReply && <Pressable onPress={() => onReply(comment)}><Text style={styles.action}>Reply</Text></Pressable>}<Pressable onPress={() => onReport(comment)}><Text style={styles.action}>Report</Text></Pressable><Pressable onPress={() => onBlock(comment)}><Text style={styles.action}>Block user</Text></Pressable></View>;
}

const styles = StyleSheet.create({
  section: { marginTop: 30, paddingTop: 22, borderTopWidth: 1, borderTopColor: colors.line }, titleRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 }, title: { color: colors.ink, fontSize: 23, fontWeight: '900' }, subtitle: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 }, guidelines: { color: colors.orangeDark, fontSize: 12, fontWeight: '900' },
  reactions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 15 }, reaction: { minWidth: 48, height: 39, paddingHorizontal: 8, borderRadius: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card }, emoji: { fontSize: 16 }, reactionCount: { color: colors.muted, fontWeight: '800', fontSize: 12 },
  join: { minHeight: 49, marginTop: 16, paddingHorizontal: 12, borderRadius: 13, backgroundColor: '#FFF3E0', borderWidth: 1, borderColor: '#FFD6A5', flexDirection: 'row', alignItems: 'center', gap: 8 }, joinText: { color: colors.orangeDark, flex: 1, fontSize: 12, fontWeight: '900' },
  composer: { marginTop: 17, padding: 13, borderRadius: 15, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line }, composerLabel: { color: colors.ink, fontSize: 13, fontWeight: '900', marginBottom: 7 }, input: { minHeight: 70, color: colors.ink, fontSize: 14, lineHeight: 19, textAlignVertical: 'top' }, composerActions: { minHeight: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, characterCount: { color: colors.muted, fontSize: 11 }, cancel: { color: colors.orangeDark, fontSize: 12, fontWeight: '800' }, post: { minWidth: 72, minHeight: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.orange }, postDisabled: { opacity: 0.48 }, postText: { color: '#fff', fontSize: 12, fontWeight: '900' }, loader: { marginVertical: 28 }, empty: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center', paddingVertical: 25 },
  thread: { marginTop: 13 }, comment: { flexDirection: 'row', gap: 9, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }, avatar: { width: 31, height: 31, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#E8F7F9' }, avatarText: { color: colors.orangeDark, fontWeight: '900' }, commentBody: { flex: 1 }, commentMeta: { flexDirection: 'row', alignItems: 'baseline', gap: 8 }, author: { color: colors.ink, fontSize: 13, fontWeight: '900' }, time: { color: colors.muted, fontSize: 10 }, commentText: { color: colors.ink, fontSize: 13, lineHeight: 19, marginTop: 4 }, commentActions: { flexDirection: 'row', gap: 15, marginTop: 8 }, action: { color: colors.orangeDark, fontSize: 11, fontWeight: '800' }, reply: { borderLeftWidth: 2, borderLeftColor: '#FFD6A5', paddingLeft: 10, marginTop: 11 }, replyAuthor: { color: colors.ink, fontSize: 12, fontWeight: '900' },
});
