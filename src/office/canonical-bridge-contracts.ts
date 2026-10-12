// Internal integration contract. These references contain no commercial values
// and do not assert that a document was accepted, a payment made or an event held.
export type BridgePartition = 'demo' | 'external';
export type BridgeScope = { organizationId: string; actorId: string; partition: BridgePartition };
export type BridgeSourcePolicy = { sourceSystem: string; partition: BridgePartition };
export type BridgeEntityKind = 'lead' | 'event' | 'quote' | 'invoice';
export type BridgeSourceReference = { sourceSystem: string; boardId: string; itemId: string };
export type BridgeSourceVersion = {
  id: string; entityId: string; kind: BridgeEntityKind; reference: BridgeSourceReference;
  sourceVersion: string; contentDigest: string;
  provenance: { evidenceRef: string; observedAtMs: number };
  recordedAtMs: number; recordedBy: string;
};
export type BridgeChainReferences = { lead: string; event: string; quote: string | null; invoice: string | null };
export type BridgeBindingRevision = {
  bindingId: string; revision: number; digest: string; previousDigest: string | null;
  action: 'bind' | 'unlink' | 'revert'; refs: BridgeChainReferences | null;
  targetRevision: number | null; evidenceRef: string; recordedAtMs: number; recordedBy: string;
};
type BridgeCommandBase = { idempotencyKey: string; expectedRevision: number };
type BridgeBindingGuard = { bindingId: string; expectedBindingRevision: number; expectedBindingDigest: string | null; evidenceRef: string };
export type BridgeCommand = BridgeCommandBase & (
  | { action: 'record_source'; kind: BridgeEntityKind; reference: BridgeSourceReference; sourceVersion: string; contentDigest: string; provenance: { evidenceRef: string; observedAtMs: number } }
  | (BridgeBindingGuard & { action: 'bind'; refs: BridgeChainReferences })
  | (BridgeBindingGuard & { action: 'unlink' })
  | (BridgeBindingGuard & { action: 'revert'; targetRevision: number })
);
export type BridgeReceipt = { replayed: boolean; deduplicated: boolean; revision: number; recorded: BridgeSourceVersion | BridgeBindingRevision };
export type BridgeSnapshot = {
  schemaVersion: 1; scope: BridgeScope; revision: number;
  sourceVersions: BridgeSourceVersion[]; bindings: BridgeBindingRevision[];
};
// The store must provide atomic, durable CAS and detached JSON values. There is
// deliberately no deletion operation: tombstones and reversions remain history.
export interface CanonicalBridgeStore {
  read(key: string): Promise<{ revision: number; value: unknown } | null>;
  compareAndSet(key: string, expectedRevision: number | null, value: unknown): Promise<boolean>;
}
