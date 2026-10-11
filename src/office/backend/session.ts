import { randomBytes, createHash } from 'node:crypto';
import type { FunctionId, OfficeCommand, OfficeSnapshot } from '../contracts';
import { CASE_IDS, DEMO_ACTOR, FUNCTION_IDS, OfficeError } from './state';
import type { DemoCaseId } from './state';

export const SESSION_COOKIE = 'gourmet_office_demo';
export const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
export type DevelopmentSession = { mode: 'demo'; actorId: typeof DEMO_ACTOR; role: 'operator' | 'viewer'; caseIds: DemoCaseId[]; functionIds: FunctionId[]; expiresAt: string; storage: { kind: 'postgres'; durable: true }; outboundEffects: 0 };
export type SessionScope = { role?: DevelopmentSession['role']; caseIds?: DemoCaseId[]; functionIds?: FunctionId[] };

export function parseSessionScope(value: unknown): SessionScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OfficeError('INVALID_SESSION_SCOPE');
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !['role', 'caseIds', 'functionIds'].includes(key))) throw new OfficeError('INVALID_SESSION_SCOPE');
  if (body.role !== undefined && !['viewer', 'operator'].includes(body.role as string)) throw new OfficeError('INVALID_SESSION_SCOPE');
  for (const [key, allowed] of [['caseIds', CASE_IDS], ['functionIds', FUNCTION_IDS]] as const) {
    const list = body[key];
    if (list !== undefined && (!Array.isArray(list) || list.length === 0 || list.some(id => !(allowed as readonly unknown[]).includes(id)) || new Set(list).size !== list.length)) throw new OfficeError('INVALID_SESSION_SCOPE');
  }
  return structuredClone(body) as SessionScope;
}

export class DevelopmentSessions {
  private sessions = new Map<string, DevelopmentSession>();
  constructor(private clock = Date.now) {}
  create(raw: unknown) {
    const scope = parseSessionScope(raw);
    this.prune();
    if (this.sessions.size >= 256) throw new OfficeError('SESSION_LIMIT', 429);
    const token = randomBytes(32).toString('hex');
    const session: DevelopmentSession = { mode: 'demo', actorId: DEMO_ACTOR, role: scope.role ?? 'operator', caseIds: scope.caseIds ?? [...CASE_IDS], functionIds: scope.functionIds ?? [...FUNCTION_IDS], expiresAt: new Date(this.clock() + SESSION_TTL_MS).toISOString(), storage: { kind: 'postgres', durable: true }, outboundEffects: 0 };
    this.sessions.set(hash(token), session);
    return { token, session: structuredClone(session) };
  }
  get(cookie: string | undefined) {
    const token = tokenFromCookie(cookie);
    const session = token ? this.sessions.get(hash(token)) : undefined;
    if (!session || Date.parse(session.expiresAt) <= this.clock()) { if (token) this.sessions.delete(hash(token)); throw new OfficeError('UNAUTHORIZED', 401); }
    return structuredClone(session);
  }
  remove(cookie: string | undefined) { const token = tokenFromCookie(cookie); if (token) this.sessions.delete(hash(token)); }
  private prune() { for (const [key, value] of this.sessions) if (Date.parse(value.expiresAt) <= this.clock()) this.sessions.delete(key); }
}
function hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
function tokenFromCookie(cookie: string | undefined) {
  if (!cookie) return undefined;
  const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return undefined;
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
export function authorizeCommand(session: DevelopmentSession, command: OfficeCommand) {
  if (session.role !== 'operator' || !session.caseIds.includes(command.caseId as DemoCaseId) || !session.functionIds.includes(command.functionId)) throw new OfficeError('FORBIDDEN_SCOPE', 403);
}
export function scopeSnapshot(snapshot: OfficeSnapshot, session: DevelopmentSession): OfficeSnapshot {
  const result = structuredClone(snapshot);
  result.cases = result.cases.filter(item => session.caseIds.includes(item.id as DemoCaseId)).map(item => {
    const scoped = { ...item, tasks: item.tasks.filter(row => session.functionIds.includes(row.functionId)), approvals: item.approvals.filter(row => session.functionIds.includes(row.functionId)), results: item.results.filter(row => session.functionIds.includes(row.functionId)), history: item.history.filter(row => session.functionIds.includes(row.functionId)), messages: item.messages.filter(row => session.functionIds.includes(row.functionId)) };
    if (!session.functionIds.includes('sales')) delete scoped.commercialThreads;
    if (scoped.supplyWorkflow) {
      if (!session.functionIds.includes('suppliers')) delete scoped.supplyWorkflow.sourcing;
      if (!session.functionIds.includes('logistics')) delete scoped.supplyWorkflow.procurement;
      if (!session.functionIds.includes('suppliers') && !session.functionIds.includes('logistics')) delete scoped.supplyWorkflow;
    }
    return scoped;
  });
  return result;
}
