import type { BridgeScope, BridgeSourceReference } from '../canonical-bridge-contracts';
import { isDeepStrictEqual } from 'node:util';
import type { ProposalTarget } from '../external-proposal-contracts';
import type { QuoteScope } from './event-quote-contracts';
import type { CanonicalBridge } from './canonical-bridge';
import { ExternalProposalError, readProposalDocument, type ExternalProposalDocumentProvider } from './external-proposal-provider';
import { snapshotProposalTarget } from './proposal-host-session';

/** Existing server-owned mapping. It is evidence selection, never permission.
 * The lead ID and CRM item occupy separate namespaces. No URL supplies IDs. */
export type CanonicalProposalSelection = {
  target: ProposalTarget; scope: QuoteScope; bridgeScope: BridgeScope;
  source: { accountId: string; boardId: string; itemId: string };
  binding: { id: string; revision: number; digest: string };
  references: { lead: BridgeSourceReference; event: BridgeSourceReference; proposal: BridgeSourceReference };
};
/** Fixed by the already authorized caller, independently of the link reader. */
export type CanonicalProposalContext = Pick<CanonicalProposalSelection, 'target' | 'scope' | 'bridgeScope' | 'source'> & { bindingId: string };
export interface ExistingCanonicalProposalLinkOwner {
  readExistingLink(target: ProposalTarget): Promise<unknown>;
}

const fail = (code = 'CANONICAL_LINK_INVALID'): never => { throw new ExternalProposalError(code); };
const id = (v: unknown, max = 128): v is string => typeof v === 'string' && v.length <= max
  && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v) && !['constructor', 'prototype', '__proto__'].includes(v);
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k))) return fail();
  for (const k of Reflect.ownKeys(descriptors)) {
    const d = descriptors[k as string]; if (typeof k !== 'string' || !d.enumerable || !('value' in d)) return fail();
  }
  return Object.fromEntries(keys.map(k => [k, descriptors[k].value]));
}
function reference(raw: unknown): BridgeSourceReference {
  const r = record(raw, ['sourceSystem', 'boardId', 'itemId']);
  if (typeof r.sourceSystem !== 'string' || !/^[a-z][a-z0-9._:-]{0,63}$/.test(r.sourceSystem) || !id(r.boardId) || !id(r.itemId)) return fail();
  return r as BridgeSourceReference;
}
function context(raw: unknown): CanonicalProposalContext {
  const s = record(raw, ['target', 'scope', 'bridgeScope', 'source', 'bindingId']);
  const scope = record(s.scope, ['organizationId', 'workspaceId', 'mode']);
  const bridgeScope = record(s.bridgeScope, ['organizationId', 'actorId', 'partition']);
  const source = record(s.source, ['accountId', 'boardId', 'itemId']);
  if (scope.mode !== 'test' || !id(scope.organizationId, 96) || !id(scope.workspaceId, 96)
    || bridgeScope.partition !== 'demo' || !id(bridgeScope.organizationId, 96) || !id(bridgeScope.actorId, 96)
    || !Object.values(source).every(v => id(v)) || !id(s.bindingId)) return fail();
  let target: ProposalTarget;
  try { target = snapshotProposalTarget(s.target); } catch { return fail(); }
  return { target, scope, bridgeScope, source, bindingId: s.bindingId } as CanonicalProposalContext;
}
function selection(raw: unknown): CanonicalProposalSelection {
  if (raw === null || raw === undefined) return fail('CANONICAL_LINK_REQUIRED');
  const s = record(raw, ['target', 'scope', 'bridgeScope', 'source', 'binding', 'references']);
  const binding = record(s.binding, ['id', 'revision', 'digest']);
  const references = record(s.references, ['lead', 'event', 'proposal']);
  const { bindingId, ...base } = context({ target: s.target, scope: s.scope, bridgeScope: s.bridgeScope, source: s.source, bindingId: binding.id });
  if (!Number.isSafeInteger(binding.revision) || (binding.revision as number) < 1
    || typeof binding.digest !== 'string' || !/^[a-f0-9]{64}$/.test(binding.digest)) return fail();
  return { ...base, binding: { id: bindingId, revision: binding.revision, digest: binding.digest },
    references: { lead: reference(references.lead), event: reference(references.event), proposal: reference(references.proposal) },
  } as CanonicalProposalSelection;
}

/** Opt-in synthetic provider adapter. The caller retains authorization ownership. */
export function createCanonicalProposalDocumentProvider(options: {
  bridge: CanonicalBridge; expected: CanonicalProposalContext;
  owner?: ExistingCanonicalProposalLinkOwner; provider?: ExternalProposalDocumentProvider;
}): ExternalProposalDocumentProvider {
  const expected = context(options.expected);
  async function readSelection(target: ProposalTarget) {
    if (!options.owner) return fail('CANONICAL_LINK_UNCONFIGURED');
    let raw: unknown;
    try { raw = await options.owner.readExistingLink(structuredClone(target)); }
    catch { return fail('CANONICAL_LINK_UNAVAILABLE'); }
    const selected = selection(raw);
    const { binding, references: _references, ...base } = selected;
    if (!isDeepStrictEqual({ ...base, bindingId: binding.id }, expected) || !isDeepStrictEqual(selected.target, target)) return fail();
    return selected;
  }
  async function current(s: CanonicalProposalSelection) {
    const state = await options.bridge.snapshot(s.bridgeScope);
    const b = state.bindings.filter(row => row.bindingId === s.binding.id).at(-1);
    if (!b?.refs || b.revision !== s.binding.revision || b.digest !== s.binding.digest || !b.refs.quote) return fail('CANONICAL_LINK_OBSOLETE');
    for (const [kind, version, expected] of [
      ['lead', b.refs.lead, s.references.lead], ['event', b.refs.event, s.references.event], ['quote', b.refs.quote, s.references.proposal],
    ] as const) {
      const row = state.sourceVersions.find(v => v.id === version);
      if (!row || row.kind !== kind || !isDeepStrictEqual(row.reference, expected)) return fail();
    }
    if (s.references.lead.boardId !== s.source.boardId || s.references.lead.itemId !== s.source.itemId
      || s.references.event.itemId !== s.target.eventId || s.references.proposal.itemId !== s.target.proposalId) return fail();
    return state.sourceVersions.find(v => v.id === b.refs!.quote)!;
  }
  return { async read(rawTarget) {
    let target: ProposalTarget;
    try { target = snapshotProposalTarget(rawTarget); } catch { return fail(); }
    if (!isDeepStrictEqual(target, expected.target)) return fail();
    const selected = await readSelection(target), quote = await current(selected);
    const { document, sha256 } = await readProposalDocument(options.provider, {
      target, scope: selected.scope, source: selected.source,
    }).catch(error => {
      if (error instanceof ExternalProposalError) throw error;
      return fail('PROVIDER_UNAVAILABLE');
    });
    if (document.sourceVersion !== quote.sourceVersion) return fail('CANONICAL_VERSION_MISMATCH');
    // null cannot verify bytes and stays reference_only in the existing service.
    if (sha256 !== null && sha256 !== quote.contentDigest) return fail('CANONICAL_CONTENT_MISMATCH');
    if (!isDeepStrictEqual(selected, await readSelection(target))) return fail('CANONICAL_LINK_CHANGED');
    await current(selected); // Reject unlink/rebind during provider I/O; never rebase.
    return document;
  } };
}
