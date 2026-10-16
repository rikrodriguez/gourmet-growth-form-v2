import { createHash } from 'node:crypto';
import type { QuoteScope } from './event-quote-contracts';
import type { ProposalTarget } from '../external-proposal-contracts';
import { historicalLeadKey, normalizeHistoricalLink, type HistoricalLinkInput } from './lead-link-history';

export class ExternalProposalError extends Error {
  constructor(readonly code: string) { super(code); }
}
export type SyntheticProposalDocument = ProposalTarget & {
  scope: QuoteScope; provider: 'synthetic'; sourceVersion: string;
  /** Exact UTF-8 text. null is reference_only, never documentary approval. */
  content: string | null; evidenceRef: string; historicalLink: HistoricalLinkInput;
};
/** Server-owned read port. No URL transport, credentials, retry, renderer or
 * provider discovery. Unknown output is validated before it can enter a case. */
export interface ExternalProposalDocumentProvider { read(target: ProposalTarget): Promise<unknown> }
export type ProposalDocumentContext = { target: ProposalTarget; scope: QuoteScope; source: { accountId: string; boardId: string; itemId: string } };
const fail = (code = 'PROVIDER_MISMATCH'): never => { throw new ExternalProposalError(code); };
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(v)
  && !['constructor', 'prototype', '__proto__'].includes(v);
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) return fail();
  for (const key of Reflect.ownKeys(descriptors)) {
    const d = descriptors[key as string]; if (typeof key !== 'string' || !d.enumerable || !('value' in d)) return fail();
  }
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
/** Syntax snapshot only; does not authorize IDs or assert that evidence belongs
 * to the selected case. Call verifyProposalDocument with its trusted context. */
export function snapshotProposalDocument(raw: unknown): SyntheticProposalDocument {
  const d = record(raw, ['leadId', 'eventId', 'proposalId', 'scope', 'provider', 'sourceVersion', 'content', 'evidenceRef', 'historicalLink']);
  const scope = record(d.scope, ['organizationId', 'workspaceId', 'mode']);
  if (![d.leadId, d.eventId, d.proposalId, d.sourceVersion, d.evidenceRef, scope.organizationId, scope.workspaceId].every(id)
    || d.provider !== 'synthetic' || scope.mode !== 'test' || d.content !== null && (typeof d.content !== 'string'
      || !d.content.trim() || Buffer.byteLength(d.content, 'utf8') > 262144 || Buffer.from(d.content, 'utf8').toString('utf8') !== d.content)) return fail();
  try { normalizeHistoricalLink(d.historicalLink as HistoricalLinkInput); } catch { return fail('SOURCE_MISMATCH'); }
  // All descriptors, including historical provenance, were checked before copy.
  return structuredClone({ ...d, scope }) as SyntheticProposalDocument;
}
export function verifyProposalDocument(raw: unknown, expected: ProposalDocumentContext) {
  const document = snapshotProposalDocument(raw);
  if (document.leadId !== expected.target.leadId || document.eventId !== expected.target.eventId || document.proposalId !== expected.target.proposalId
    || document.scope.mode !== 'test' || document.scope.mode !== expected.scope.mode || document.scope.organizationId !== expected.scope.organizationId
    || document.scope.workspaceId !== expected.scope.workspaceId) return fail();
  const history = normalizeHistoricalLink(document.historicalLink);
  if (history.status === 'quarantined' || history.category !== 'quote' || historicalLeadKey(history.provenance) !== historicalLeadKey(expected.source)) return fail('SOURCE_MISMATCH');
  return { document, sha256: document.content === null ? null : createHash('sha256').update(document.content, 'utf8').digest('hex'), referenceOnly: document.content === null };
}
export async function readProposalDocument(provider: ExternalProposalDocumentProvider | undefined, expected: ProposalDocumentContext) {
  const context = structuredClone(expected);
  if (!provider) return fail('PROVIDER_REQUIRED');
  const raw = await provider.read(structuredClone(context.target));
  return verifyProposalDocument(raw, context);
}
