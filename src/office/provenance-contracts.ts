import type { BridgeBindingRevision, BridgePartition, BridgeSnapshot, BridgeSourceVersion } from './canonical-bridge-contracts';
import type { FunctionId } from './contracts';

export type BridgeReadModel = {
  state: 'unconfigured' | 'empty' | 'available' | 'unavailable' | 'scope_restricted';
  partition: BridgePartition; storage: 'postgres' | null; revision: number | null;
  sourceVersions: BridgeSourceVersion[]; bindings: BridgeBindingRevision[];
  importsEnabled: false; automaticLinking: false; metricsConsumed: false;
  coverage: 'complete' | 'partial' | 'not_queried';
};
export type DemoProvenanceEvidence = { caseId: string; source: string; reference: string; observedAt: string; simulated: true };
export type DemoProvenance = {
  schemaVersion: 1; source: 'demo'; synthetic: true; readAt: string;
  coverage: { caseIds: string[]; functionIds: FunctionId[] };
  officeEvidence: DemoProvenanceEvidence[]; bridge: BridgeReadModel;
};
export type MondayProvenance = {
  schemaVersion: 1; source: 'monday'; synthetic: false; readAt: string;
  connection: {
    state: 'disabled' | 'connected' | 'disconnected' | 'error' | 'expired'; configured: boolean;
    boardAccessVerified: boolean; identityReadAt: string | null; lastReadAt: string | null; expiresAt: string | null;
  };
  bridge: BridgeReadModel;
};

const CASE_IDS = ['demo-aurora', 'demo-cedar', 'demo-harbor'];
const FUNCTION_IDS: FunctionId[] = ['sales', 'proposals', 'coordination', 'logistics', 'suppliers', 'finance', 'quality', 'marketing', 'talent'];
function fail(): never { throw new Error('Invalid provenance contract.'); }
function detached(value: unknown): unknown {
  const ancestors = new Set<object>();
  const visit = (current: unknown, depth: number): void => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number' && Number.isFinite(current)) return;
    if (!current || typeof current !== 'object' || depth > 24 || ancestors.has(current)) fail();
    const array = Array.isArray(current); const keys = Reflect.ownKeys(current);
    if (array ? Object.getPrototypeOf(current) !== Array.prototype || keys.length !== current.length + 1 : ![Object.prototype, null].includes(Object.getPrototypeOf(current))) fail();
    if (keys.length > 20_000) fail();
    ancestors.add(current);
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !field || !('value' in field) || (!array || key !== 'length') && !field.enumerable || array && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) fail();
      visit(field.value, depth + 1);
    }
    ancestors.delete(current);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > 1_048_576) fail();
  return JSON.parse(json) as unknown;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) fail(); return value; }
function token(value: unknown, max = 128): value is string { return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value); }
function integer(value: unknown, min = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= min && (value as number) < Number.MAX_SAFE_INTEGER; }
function time(value: unknown): value is number { return integer(value) && value <= 8_640_000_000_000_000; }
function date(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function demoSource(value: string) { return /^(?:fixture|demo)[:._-]/.test(value); }
function reference(value: unknown, partition: BridgePartition) {
  const row = record(value, ['sourceSystem', 'boardId', 'itemId']);
  if (typeof row.sourceSystem !== 'string' || !/^[a-z][a-z0-9._:-]{0,63}$/.test(row.sourceSystem) || !token(row.boardId) || !token(row.itemId) || demoSource(row.sourceSystem) !== (partition === 'demo')) fail();
}
function rows(sourceValues: unknown, bindingValues: unknown, partition: BridgePartition, max: number, complete: boolean, actor?: string) {
  const sources = list(sourceValues, max); const bindings = list(bindingValues, max);
  const versions = new Map<string, Record<string, unknown>>(); const entities = new Map<string, string>(); const sourceKeys = new Set<string>();
  for (const value of sources) {
    const row = record(value, ['id', 'entityId', 'kind', 'reference', 'sourceVersion', 'contentDigest', 'provenance', 'recordedAtMs', 'recordedBy']);
    const proof = record(row.provenance, ['evidenceRef', 'observedAtMs']);
    if (!token(row.id) || !token(row.entityId) || !['lead', 'event', 'quote', 'invoice'].includes(row.kind as string) || !token(row.sourceVersion) || !digest(row.contentDigest) || !token(row.recordedBy, 96) || actor !== undefined && row.recordedBy !== actor || !time(row.recordedAtMs) || !token(proof.evidenceRef) || !time(proof.observedAtMs) || proof.observedAtMs > row.recordedAtMs || versions.has(row.id)) fail();
    reference(row.reference, partition);
    const identity = JSON.stringify([row.kind, row.reference]); const prior = entities.get(row.entityId);
    if (prior !== undefined && prior !== identity) fail();
    const versionKey = JSON.stringify([row.entityId, row.sourceVersion]); if (sourceKeys.has(versionKey)) fail();
    entities.set(row.entityId, identity); sourceKeys.add(versionKey); versions.set(row.id, row);
  }
  const history = new Map<string, Record<string, unknown>>();
  for (const value of bindings) {
    const row = record(value, ['bindingId', 'revision', 'digest', 'previousDigest', 'action', 'refs', 'targetRevision', 'evidenceRef', 'recordedAtMs', 'recordedBy']);
    if (!token(row.bindingId) || !integer(row.revision, 1) || !digest(row.digest) || row.previousDigest !== null && !digest(row.previousDigest) || !['bind', 'unlink', 'revert'].includes(row.action as string) || row.targetRevision !== null && !integer(row.targetRevision, 1) || !token(row.evidenceRef) || !time(row.recordedAtMs) || !token(row.recordedBy, 96) || actor !== undefined && row.recordedBy !== actor) fail();
    const previous = history.get(row.bindingId);
    if (row.revision !== (previous?.revision as number ?? 0) + 1 || row.previousDigest !== (previous?.digest ?? null) || row.action === 'revert' && (row.targetRevision === null || (row.targetRevision as number) >= row.revision) || row.action !== 'revert' && row.targetRevision !== null || row.action === 'unlink' && row.refs !== null || row.action === 'bind' && row.refs === null) fail();
    if (row.refs !== null) {
      const refs = record(row.refs, ['lead', 'event', 'quote', 'invoice']);
      if (!token(refs.lead) || !token(refs.event) || refs.quote !== null && !token(refs.quote) || refs.invoice !== null && !token(refs.invoice) || refs.invoice !== null && refs.quote === null) fail();
      for (const kind of ['lead', 'event', 'quote', 'invoice'] as const) {
        const id = refs[kind]; const source = typeof id === 'string' ? versions.get(id) : undefined;
        if (id !== null && (complete && !source || source && source.kind !== kind)) fail();
      }
    }
    history.set(row.bindingId, row);
  }
  return sources.length + bindings.length;
}
export function validateBridgeSnapshot(value: unknown): BridgeSnapshot {
  const clean = detached(value); const row = record(clean, ['schemaVersion', 'scope', 'revision', 'sourceVersions', 'bindings']);
  const scope = record(row.scope, ['organizationId', 'actorId', 'partition']);
  if (row.schemaVersion !== 1 || !token(scope.organizationId, 96) || !token(scope.actorId, 96) || !['demo', 'external'].includes(scope.partition as string) || !integer(row.revision)) fail();
  const count = rows(row.sourceVersions, row.bindings, scope.partition as BridgePartition, 1000, true, scope.actorId);
  if (count > 1000 || count > row.revision) fail();
  return clean as BridgeSnapshot;
}
function bridge(value: unknown, partition: BridgePartition) {
  const row = record(value, ['state', 'partition', 'storage', 'revision', 'sourceVersions', 'bindings', 'importsEnabled', 'automaticLinking', 'metricsConsumed', 'coverage']);
  if (!['unconfigured', 'empty', 'available', 'unavailable', 'scope_restricted'].includes(row.state as string) || row.partition !== partition || row.importsEnabled !== false || row.automaticLinking !== false || row.metricsConsumed !== false || !['complete', 'partial', 'not_queried'].includes(row.coverage as string)) fail();
  // Current DEMO sessions use this single synthetic actor. A future multi-actor
  // view requires its own explicit authorization contract rather than accepting
  // arbitrary actors merely because a row claims a DEMO partition.
  const count = rows(row.sourceVersions, row.bindings, partition, 50, row.coverage === 'complete', partition === 'demo' ? 'OFFICE_DEMO_OPERATOR' : undefined);
  if (['empty', 'available'].includes(row.state as string)) {
    if (row.storage !== 'postgres' || !integer(row.revision) || row.coverage === 'not_queried' || count > row.revision || (row.state === 'empty' ? count !== 0 || row.coverage !== 'complete' : count === 0)) fail();
  } else if (row.storage !== null || row.revision !== null || count !== 0 || row.coverage !== 'not_queried') fail();
  // There is no authorized external workspace/organization binding in this lot.
  if (partition === 'external' && row.state !== 'unconfigured') fail();
}
export function validateDemoProvenance(value: unknown): DemoProvenance {
  const clean = detached(value); const row = record(clean, ['schemaVersion', 'source', 'synthetic', 'readAt', 'coverage', 'officeEvidence', 'bridge']);
  if (row.schemaVersion !== 1 || row.source !== 'demo' || row.synthetic !== true || !date(row.readAt)) fail();
  const coverage = record(row.coverage, ['caseIds', 'functionIds']);
  const cases = list(coverage.caseIds, CASE_IDS.length); const functions = list(coverage.functionIds, FUNCTION_IDS.length);
  if (!cases.length || !functions.length || new Set(cases).size !== cases.length || new Set(functions).size !== functions.length || cases.some(id => !CASE_IDS.includes(id as string)) || functions.some(id => !FUNCTION_IDS.includes(id as FunctionId))) fail();
  for (const value of list(row.officeEvidence, 50)) {
    const evidence = record(value, ['caseId', 'source', 'reference', 'observedAt', 'simulated']);
    if (!cases.includes(evidence.caseId) || evidence.simulated !== true || !token(evidence.source) || !demoSource(evidence.source) || !token(evidence.reference) || !evidence.reference.startsWith(`demo:${evidence.caseId}:`) || !date(evidence.observedAt)) fail();
  }
  bridge(row.bridge, 'demo');
  return clean as DemoProvenance;
}
export function validateMondayProvenance(value: unknown): MondayProvenance {
  const clean = detached(value); const row = record(clean, ['schemaVersion', 'source', 'synthetic', 'readAt', 'connection', 'bridge']);
  if (row.schemaVersion !== 1 || row.source !== 'monday' || row.synthetic !== false || !date(row.readAt)) fail();
  const connection = record(row.connection, ['state', 'configured', 'boardAccessVerified', 'identityReadAt', 'lastReadAt', 'expiresAt']);
  if (!['disabled', 'connected', 'disconnected', 'error', 'expired'].includes(connection.state as string) || typeof connection.configured !== 'boolean' || typeof connection.boardAccessVerified !== 'boolean') fail();
  for (const key of ['identityReadAt', 'lastReadAt', 'expiresAt']) if (connection[key] !== null && !date(connection[key])) fail();
  bridge(row.bridge, 'external');
  return clean as MondayProvenance;
}
