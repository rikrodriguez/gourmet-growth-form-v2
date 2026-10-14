import { validateLeadLinkResponse, type LeadLinkResponse, type LeadLinkResponseScope } from '../lead-link-response';

export type DashboardLeadLinkGrant = {
  state: 'ready'; identityKey: string; durableIdentity: boolean; scope: LeadLinkResponseScope;
  expiresAtMs: number; canRead: boolean; canOpen: boolean; leadIds: string[];
};
export type DashboardLeadLinkAccess = DashboardLeadLinkGrant | { state: 'unconfigured' | 'unavailable' };
/** Same trusted identity owner as the HTTP resolver. This projection never authenticates or grants authority. */
export interface DashboardLeadLinkAccessSource {
  read(signal: AbortSignal): Promise<DashboardLeadLinkAccess>;
  subscribe(onWithdraw: () => void): () => void;
}
export interface LeadLinkClient { read(leadId: string, signal: AbortSignal): Promise<LeadLinkResponse> }
export const unconfiguredLeadLinkAccess: DashboardLeadLinkAccessSource = { async read() { return { state: 'unconfigured' }; }, subscribe() { return () => {}; } };
export class LeadLinkClientError extends Error {
  constructor(readonly code: 'ACCESS_DENIED' | 'CANCELLED' | 'UNAVAILABLE' | 'INVALID_RESPONSE', readonly status = 0) { super(code); }
}
const deny = (): never => { throw new LeadLinkClientError('ACCESS_DENIED', 403); };
const id = (v: unknown, max = 96, rejectReserved = true): v is string => typeof v === 'string' && v.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(v) && (!rejectReserved || !['constructor','prototype','__proto__','status','session','grant','grants'].includes(v));
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && Reflect.ownKeys(v).every(key => { const d = Object.getOwnPropertyDescriptor(v, key); return typeof key === 'string' && !!d?.enumerable && 'value' in d; });
const denseArray = (v: unknown): v is unknown[] => Array.isArray(v) && Object.getPrototypeOf(v) === Array.prototype
  && Reflect.ownKeys(v).length === v.length + 1 && Array.from({length:v.length}, (_,i) => Object.getOwnPropertyDescriptor(v,String(i))).every(d => !!d?.enumerable && 'value' in d);
/** Strict copies prevent mutable source data from broadening a granted scope. */
export function validateLeadLinkAccess(raw: unknown, now = Date.now()): DashboardLeadLinkAccess {
  if (!plain(raw)) return deny();
  if (raw.state === 'unconfigured' || raw.state === 'unavailable') return { state: raw.state };
  const scope = raw.scope;
  if (raw.state !== 'ready' || !id(raw.identityKey, 256, false) || typeof raw.durableIdentity !== 'boolean' || !plain(scope)
    || !id(scope.organizationId, 128) || !id(scope.workspaceId, 128) || scope.mode !== 'test' && scope.mode !== 'commercial'
    || scope.mode === 'commercial' && raw.durableIdentity !== true || raw.canRead !== true || typeof raw.canOpen !== 'boolean'
    || !Number.isSafeInteger(raw.expiresAtMs) || (raw.expiresAtMs as number) <= now
    || !denseArray(raw.leadIds) || raw.leadIds.length > 1000 || raw.leadIds.some(v => !id(v)) || new Set(raw.leadIds).size !== raw.leadIds.length) return deny();
  return { state: 'ready', identityKey: raw.identityKey, durableIdentity: raw.durableIdentity,
    scope: { organizationId: scope.organizationId, workspaceId: scope.workspaceId, mode: scope.mode as 'test' | 'commercial' },
    expiresAtMs: Math.min(raw.expiresAtMs as number, now + 15 * 60_000), canRead: true, canOpen: raw.canOpen, leadIds: [...raw.leadIds] as string[] };
}
export class LeadLinkReadGate {
  private epoch = 0; private controller: AbortController | null = null;
  start() { this.cancel(); const epoch = this.epoch, controller = new AbortController(); this.controller = controller;
    return { signal: controller.signal, current: () => epoch === this.epoch && !controller.signal.aborted }; }
  cancel() { this.epoch += 1; this.controller?.abort(); this.controller = null; }
}
export const leadLinkClient: LeadLinkClient = {
  async read(leadId, signal) {
    if (!id(leadId)) return deny();
    const response = await fetch(`/api/office/lead-links/${encodeURIComponent(leadId)}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new LeadLinkClientError(response.status === 401 || response.status === 403 ? 'ACCESS_DENIED' : 'UNAVAILABLE', response.status);
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new LeadLinkClientError('INVALID_RESPONSE');
    try { return validateLeadLinkResponse(await response.json()); } catch { throw new LeadLinkClientError('INVALID_RESPONSE'); }
  },
};
/** UI ceiling only. Exact identity+tenant+lead matching; the server remains the authority. */
export function bindLeadLinkClient(client: LeadLinkClient, input: DashboardLeadLinkGrant,
  lifetime: { signal: AbortSignal; current(): boolean }, clock = Date.now): LeadLinkClient {
  const access = validateLeadLinkAccess(input, clock()); if (access.state !== 'ready') return deny();
  const check = (leadId: string, signal: AbortSignal) => {
    if (!lifetime.current() || lifetime.signal.aborted || signal.aborted) throw new LeadLinkClientError('CANCELLED');
    if (clock() >= access.expiresAtMs || !access.leadIds.includes(leadId)) deny();
  };
  return { async read(leadId, signal) {
    check(leadId, signal);
    const raw = await client.read(leadId, AbortSignal.any([signal, lifetime.signal]));
    check(leadId, signal);
    let response: LeadLinkResponse; try { response = validateLeadLinkResponse(raw); } catch { throw new LeadLinkClientError('INVALID_RESPONSE'); }
    if (response.identityKey !== access.identityKey || response.leadId !== leadId
      || response.scope.organizationId !== access.scope.organizationId || response.scope.workspaceId !== access.scope.workspaceId || response.scope.mode !== access.scope.mode) deny();
    if (response.openingSession.expiresAtMs <= clock()) deny();
    const canOpen = response.openingSession.canOpen && access.canOpen;
    return { ...response, history: { ...response.history, links: response.history.links.map(link => ({ ...link, opening: canOpen ? link.opening : null })) },
      openingSession: { canOpen, csrfToken: canOpen ? response.openingSession.csrfToken : null, expiresAtMs: Math.min(access.expiresAtMs, response.openingSession.expiresAtMs) } };
  } };
}
