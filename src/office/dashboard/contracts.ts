// Read-only dashboard contract. A connector being configured is not proof of
// complete data. No command, provider credential or send capability belongs here.
export type Coverage = 'complete' | 'partial' | 'unknown';
export type Channel = 'email' | 'web' | 'instagram' | 'messenger';
export type Stage = 'new' | 'qualifying' | 'proposal' | 'confirmed';
export type SourceId = 'sample' | 'monday' | 'gmail' | 'web' | 'instagram' | 'messenger' | 'payments' | 'ads' | 'catalog';
export type SourceStatus = { id: SourceId; label: string; mode: 'fixture' | 'unconfigured'; coverage: Coverage; lastVerifiedAt: string | null; note: string };
export type Opportunity = { id: string; name: string; event: string; stage: Stage; guests: number | null; eventDate: string | null; enteredStageAt: string | null; amountMinor: number | null; currency: string | null; sourceId: 'sample'; channel: Channel };
export type Conversation = { id: string; contact: string; subject: string; bodyText: string; channel: Channel; mailbox: string | null; state: 'needs_review' | 'unread' | 'waiting'; at: string; sourceId: 'sample'; opportunityId: string | null };
export type Activity = { id: string; label: string; at: string; sourceId: 'sample'; kind: 'inquiry' | 'proposal' | 'review' };
export type DashboardSnapshot = { mode: 'fixture'; asOf: string; periodStart: string; sources: SourceStatus[]; opportunities: Opportunity[]; conversations: Conversation[]; activity: Activity[]; outboundEffects: 0 };
export type Metric = { id: 'opportunities' | 'pipeline' | 'conversion' | 'revenue' | 'ads'; label: string; value: number | null; unit: 'count' | 'money' | 'percent'; currency: string | null; coverage: Coverage; note: string };
export type ApprovalQueueItem = { id: string; revision: number; digest: string; subject: string; recipient: string; mailbox: string; state: 'needs_review' | 'blocked' | 'approved_unsent'; reason: string; href: '/office/communications' };
export type ApprovalQueue = { mode: 'fixture'; workflowRevision: number; expiresAt: string; items: ApprovalQueueItem[]; outboundEffects: 0 };
export interface DashboardReadSource { readonly mode: 'fixture'; read(signal: AbortSignal): Promise<DashboardSnapshot> }
export interface DashboardReviewSource { read(signal: AbortSignal): Promise<ApprovalQueue> }
