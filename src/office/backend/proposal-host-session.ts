import { EventQuoteError, type QuoteScope } from './event-quote-contracts';
import type { ExistingQuoteSession } from './quote-access-postgres';
import type { ProposalTarget } from '../external-proposal-contracts';

/** Constraints supplied by the existing session owner, never new authority.
 * SQL must corroborate actor/scope/event and can only shorten this lifetime. */
export type ExistingQuoteHostBinding = Readonly<{ scope: QuoteScope; actorId: string; eventId: string; expiresAtMs: number }>;
export type ExistingProposalSession = ExistingQuoteSession & { readonly proposalTarget?: ProposalTarget };
export type ExistingProposalHostSession = {
  proof: Pick<ExistingQuoteSession, 'sessionToken' | 'csrfToken'>;
  scope: QuoteScope; actorId: string; target: ProposalTarget; expiresAtMs: number;
};
export interface ExistingProposalSessionOwner<Request> {
  /** Read the already authenticated server session and its already mapped case.
   * No implementation is assumed for the current DEMO/Basic/bootstrap sessions. */
  readExistingSession(request: Request): Promise<unknown> | unknown;
}
const fail = (code = 'AUTHENTICATION_REQUIRED', status = 401): never => { throw new EventQuoteError(code, status); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(v)
  && !['constructor', 'prototype', '__proto__', 'status', 'session', 'grant', 'grants'].includes(v);
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) return fail();
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key as string]; if (typeof key !== 'string' || !d.enumerable || !('value' in d)) return fail();
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function scope(raw: unknown): QuoteScope {
  const value = record(raw, ['organizationId', 'workspaceId', 'mode']);
  if (value.mode !== 'test' || !id(value.organizationId) || !id(value.workspaceId)) return fail();
  return { organizationId: value.organizationId, workspaceId: value.workspaceId, mode: 'test' };
}
export function snapshotProposalTarget(raw: unknown): ProposalTarget {
  const target = record(raw, ['leadId', 'eventId', 'proposalId']);
  if (!id(target.leadId) || !id(target.eventId) || !id(target.proposalId)) return fail();
  return { leadId: target.leadId, eventId: target.eventId, proposalId: target.proposalId };
}
export function snapshotQuoteHostBinding(raw: unknown): ExistingQuoteHostBinding {
  const value = record(raw, ['scope', 'actorId', 'eventId', 'expiresAtMs']);
  if (!id(value.actorId) || !id(value.eventId) || !Number.isSafeInteger(value.expiresAtMs) || (value.expiresAtMs as number) < 1) return fail();
  return { scope: scope(value.scope), actorId: value.actorId, eventId: value.eventId, expiresAtMs: value.expiresAtMs as number };
}
/** Integrates with the current HTTP resolver seam. No cookie/header guessing,
 * login, issuer, grants, default principal, I/O or commercial mode activation. */
export function createExistingProposalSessionResolver<Request>(options: {
  target: ProposalTarget; owner?: ExistingProposalSessionOwner<Request>; clock?: () => number;
}): (request: Request) => Promise<ExistingProposalSession> {
  const target = snapshotProposalTarget(options.target), owner = options.owner, clock = options.clock ?? Date.now;
  return async request => {
    if (!owner) return fail('HOST_SESSION_UNCONFIGURED', 503);
    let raw: unknown;
    try { raw = await owner.readExistingSession(request); } catch { return fail('HOST_SESSION_UNAVAILABLE', 503); }
    const value = record(raw, ['proof', 'scope', 'actorId', 'target', 'expiresAtMs']);
    const proof = record(value.proof, ['sessionToken', 'csrfToken']), selected = snapshotProposalTarget(value.target);
    if (!Object.values(proof).every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{16,512}$/.test(v))
      || JSON.stringify(selected) !== JSON.stringify(target)) return fail();
    const hostIdentity = snapshotQuoteHostBinding({ scope: value.scope, actorId: value.actorId, eventId: target.eventId, expiresAtMs: value.expiresAtMs });
    const now = clock(); if (!Number.isSafeInteger(now) || hostIdentity.expiresAtMs <= now) return fail();
    return { sessionToken: proof.sessionToken as string, csrfToken: proof.csrfToken as string, hostIdentity, proposalTarget: { ...target } };
  };
}
