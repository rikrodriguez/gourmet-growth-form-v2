import type { WorkflowView } from './backend/communications';

// Browser contract only. Identity, observations and coverage are server-owned.
export type CommunicationsSessionView = {
  mode: 'fixture'; actorId: string; organizationId: string; csrfToken: string;
  expiresAt: string; storage: 'ephemeral' | 'postgres'; outboundEffects: 0;
};
export type CommunicationsReviewView = {
  mode: 'fixture'; session: CommunicationsSessionView; workflow: WorkflowView;
};
export const COMMUNICATIONS_API = '/office-api/communications';
export const COMMUNICATIONS_CSRF_HEADER = 'x-communications-csrf';
