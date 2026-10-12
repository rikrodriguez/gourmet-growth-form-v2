const CALLBACK_STAGES = [
  'callback_query', 'callback_nonce', 'callback_state', 'provider_decision',
  'token_exchange', 'token_response', 'identity_check', 'board_access_check', 'persist_connection',
] as const;
const CALLBACK_REASONS = [
  'disabled', 'configuration_invalid', 'oauth_state_invalid', 'oauth_state_expired',
  'oauth_denied', 'operation_in_progress', 'code_exchange_uncertain', 'token_invalid',
  'scope_mismatch', 'identity_mismatch', 'board_access_unverified', 'connection_changed',
  'storage_unavailable', 'callback_failed',
] as const;
export type MondayOAuthCallbackStage = typeof CALLBACK_STAGES[number];
export type MondayOAuthCallbackReason = typeof CALLBACK_REASONS[number];
export type MondayOAuthReturnDiagnostic = Readonly<{ stage: MondayOAuthCallbackStage; reason: MondayOAuthCallbackReason }>;

export function isMondayOAuthCallbackStage(value: unknown): value is MondayOAuthCallbackStage {
  return typeof value === 'string' && (CALLBACK_STAGES as readonly string[]).includes(value);
}
export function mondayOAuthCallbackReason(value: unknown): MondayOAuthCallbackReason {
  return typeof value === 'string' && (CALLBACK_REASONS as readonly string[]).includes(value)
    ? value as MondayOAuthCallbackReason : 'callback_failed';
}
export function mondayOAuthErrorReturn(stage: unknown, reason: unknown): string {
  const safeStage = isMondayOAuthCallbackStage(stage) ? stage : 'callback_state';
  // Every output value is a fixed literal. Never reflect callback input, error
  // messages, provider descriptions, tokens, cookies or endpoint URLs.
  return `/office/monday?oauth=error&stage=${safeStage}&reason=${mondayOAuthCallbackReason(reason)}`;
}
export function parseMondayOAuthReturn(search: string): MondayOAuthReturnDiagnostic | null {
  // A browser can forge this marker. It explains a return and never proves an
  // owner session, a grant or a connection. Invalid markers are simply ignored.
  if (search.length > 512) return null;
  const query = new URLSearchParams(search);
  const fields = ['oauth', 'stage', 'reason'];
  if ([...query.keys()].some(key => !fields.includes(key)) || fields.some(key => query.getAll(key).length !== 1)
    || query.get('oauth') !== 'error') return null;
  const stage = query.get('stage'), reason = query.get('reason');
  if (!isMondayOAuthCallbackStage(stage) || typeof reason !== 'string' || !(CALLBACK_REASONS as readonly string[]).includes(reason)) return null;
  return { stage, reason: reason as MondayOAuthCallbackReason };
}
