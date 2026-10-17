import { createHash } from 'node:crypto';
import type { BridgeScope } from '../../src/office/canonical-bridge-contracts';
import type { CanonicalBridge } from '../../src/office/backend/canonical-bridge';
import type { SyntheticProposalDocument } from '../../src/office/backend/external-proposal-provider';

/** Explicit synthetic canonical observation, using the existing fixture ledger. */
export async function linkCanonicalDocument(bridge: CanonicalBridge, scope: BridgeScope, bindingId: string,
  document: SyntheticProposalDocument, patch: { proposalId?: string; sourceVersion?: string; contentDigest?: string } = {}) {
  let state = await bridge.snapshot(scope);
  const prior = state.bindings.filter(b => b.bindingId === bindingId).at(-1)!;
  const receipt = await bridge.execute(scope, { action: 'record_source', idempotencyKey: `canonical-quote-${state.revision}`,
    expectedRevision: state.revision, kind: 'quote',
    reference: { sourceSystem: 'fixture:proposal', boardId: 'synthetic-document-board', itemId: patch.proposalId ?? document.proposalId },
    sourceVersion: patch.sourceVersion ?? document.sourceVersion,
    contentDigest: patch.contentDigest ?? createHash('sha256').update(document.content!).digest('hex'),
    provenance: { evidenceRef: 'synthetic-canonical-document', observedAtMs: prior.recordedAtMs },
  });
  if (!('id' in receipt.recorded)) throw new Error('Invalid canonical fixture');
  state = await bridge.snapshot(scope);
  return bridge.execute(scope, { action: 'bind', idempotencyKey: `canonical-link-${state.revision}`, expectedRevision: state.revision,
    bindingId, expectedBindingRevision: prior.revision, expectedBindingDigest: prior.digest,
    evidenceRef: 'synthetic-canonical-document-link', refs: { ...prior.refs!, quote: receipt.recorded.id },
  });
}
