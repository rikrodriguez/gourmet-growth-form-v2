import { createHash } from 'node:crypto';
import type { BridgeScope, BridgeSnapshot, BridgeReceipt, BridgeSourcePolicy, BridgeBindingRevision, BridgeCommand, BridgeSourceReference, BridgeSourceVersion, BridgeChainReferences, CanonicalBridgeStore } from '../canonical-bridge-contracts';

export class CanonicalBridgeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'CanonicalBridgeError'; }
}

const MAX_EVENTS = 1000;
const MAX_BYTES = 1_048_576;
function fail(code: string): never { throw new CanonicalBridgeError(code); }
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const token = (value: unknown, max = 128): value is string => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) < Number.MAX_SAFE_INTEGER;
const time = (value: unknown): value is number => integer(value) && (value as number) <= 8_640_000_000_000_000;
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

// Reject accessors, executable serializers and lossy JSON before reading data.
// All public inputs and store values are detached before an asynchronous boundary.
function data(value: unknown, code: string): unknown {
  const ancestors = new Set<object>();
  function visit(current: unknown, depth: number): void {
    if (current === null || typeof current === 'string' || typeof current === 'boolean' || typeof current === 'number' && Number.isFinite(current)) return;
    if (!current || typeof current !== 'object' || depth > 24 || ancestors.has(current)) fail(code);
    const array = Array.isArray(current);
    if (array ? Object.getPrototypeOf(current) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(current))) fail(code);
    const keys = Reflect.ownKeys(current);
    if (keys.length > 20_000 || array && keys.length !== current.length + 1) fail(code);
    ancestors.add(current);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || (!array || key !== 'length') && !descriptor.enumerable || array && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) fail(code);
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(current);
  }
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) fail(code);
  return JSON.parse(serialized) as unknown;
}
function object(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail(code);
  return value as Record<string, unknown>;
}
function scopeInput(raw: unknown): BridgeScope {
  const body = object(data(raw, 'BRIDGE_INVALID_SCOPE'), ['organizationId', 'actorId', 'partition'], 'BRIDGE_INVALID_SCOPE');
  if (!token(body.organizationId, 96) || !token(body.actorId, 96) || !['demo', 'external'].includes(body.partition as string)) fail('BRIDGE_INVALID_SCOPE');
  return body as BridgeScope;
}
function referenceInput(raw: unknown): BridgeSourceReference {
  const body = object(raw, ['sourceSystem', 'boardId', 'itemId'], 'BRIDGE_INVALID_COMMAND');
  if (typeof body.sourceSystem !== 'string' || !/^[a-z][a-z0-9._:-]{0,63}$/.test(body.sourceSystem) || !token(body.boardId) || !token(body.itemId)) fail('BRIDGE_INVALID_COMMAND');
  return body as BridgeSourceReference;
}
function refsInput(raw: unknown): BridgeChainReferences {
  const body = object(raw, ['lead', 'event', 'quote', 'invoice'], 'BRIDGE_INVALID_COMMAND');
  if (!token(body.lead) || !token(body.event) || body.quote !== null && !token(body.quote) || body.invoice !== null && !token(body.invoice)) fail('BRIDGE_INVALID_COMMAND');
  return body as BridgeChainReferences;
}
function commandInput(raw: unknown): BridgeCommand {
  const value = data(raw, 'BRIDGE_INVALID_COMMAND');
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BRIDGE_INVALID_COMMAND');
  const action = (value as Record<string, unknown>).action;
  const base = ['idempotencyKey', 'expectedRevision', 'action'];
  const guard = ['bindingId', 'expectedBindingRevision', 'expectedBindingDigest', 'evidenceRef'];
  const fields = action === 'record_source' ? [...base, 'kind', 'reference', 'sourceVersion', 'contentDigest', 'provenance']
    : action === 'bind' ? [...base, ...guard, 'refs'] : action === 'unlink' ? [...base, ...guard]
      : action === 'revert' ? [...base, ...guard, 'targetRevision'] : fail('BRIDGE_INVALID_COMMAND');
  const body = object(value, fields, 'BRIDGE_INVALID_COMMAND');
  if (!token(body.idempotencyKey) || !integer(body.expectedRevision)) fail('BRIDGE_INVALID_COMMAND');
  if (action === 'record_source') {
    if (!['lead', 'event', 'quote', 'invoice'].includes(body.kind as string) || !token(body.sourceVersion) || !digest(body.contentDigest)) fail('BRIDGE_INVALID_COMMAND');
    referenceInput(body.reference);
    const provenance = object(body.provenance, ['evidenceRef', 'observedAtMs'], 'BRIDGE_INVALID_COMMAND');
    if (!token(provenance.evidenceRef) || !time(provenance.observedAtMs)) fail('BRIDGE_INVALID_COMMAND');
  } else {
    if (!token(body.bindingId) || !integer(body.expectedBindingRevision) || body.expectedBindingDigest !== null && !digest(body.expectedBindingDigest) || !token(body.evidenceRef)) fail('BRIDGE_INVALID_COMMAND');
    if (action === 'bind') refsInput(body.refs);
    if (action === 'revert' && !integer(body.targetRevision, 1)) fail('BRIDGE_INVALID_COMMAND');
  }
  return body as BridgeCommand;
}
const workspaceKey = (scope: BridgeScope) => `bridge-${hash([scope.organizationId, scope.actorId, scope.partition])}`;
const entityId = (scope: BridgeScope, ref: BridgeSourceReference) => `entity-${hash([scope.organizationId, scope.actorId, scope.partition, ref.sourceSystem, ref.boardId, ref.itemId])}`;
type Event = { command: BridgeCommand; atMs: number; receipt: BridgeReceipt; previousDigest: string | null; digest: string };
export type CanonicalBridgeLedgerEvent = Event;
export type ValidatedCanonicalBridgeValue = { scope: BridgeScope; revision: number; events: CanonicalBridgeLedgerEvent[]; lastDigest: string; lastAtMs: number; value: unknown };
type Ledger = { schemaVersion: 1; scope: BridgeScope; revision: number; events: Event[] };
type Projection = { sourceVersions: BridgeSourceVersion[]; bindings: BridgeBindingRevision[] };

export class MemoryCanonicalBridgeStore implements CanonicalBridgeStore {
  private rows = new Map<string, { revision: number; value: unknown }>();
  async read(key: string): Promise<{ revision: number; value: unknown } | null> {
    if (!/^bridge-[a-f0-9]{64}$/.test(key)) fail('BRIDGE_STORE_UNAVAILABLE');
    const row = this.rows.get(key);
    return row ? structuredClone(row) : null;
  }
  async compareAndSet(key: string, expectedRevision: number | null, value: unknown): Promise<boolean> {
    if (!/^bridge-[a-f0-9]{64}$/.test(key) || expectedRevision !== null && !integer(expectedRevision, 1)) fail('BRIDGE_STORE_UNAVAILABLE');
    const copy = data(value, 'BRIDGE_STATE_INVALID');
    const current = this.rows.get(key);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    const revision = (current?.revision ?? 0) + 1;
    if (!integer(revision, 1)) fail('BRIDGE_STORE_UNAVAILABLE');
    this.rows.set(key, { revision, value: copy });
    return true;
  }
}

// Internal preparation API only. The caller authenticates/authorizes scope and
// supplies a trusted source registry. Its optional provenance consumer only
// reads; no importer, write route or metrics consumer is enabled, and
// the existing DEMO aggregate is never accessed by the bridge.
export class CanonicalBridge {
  private readonly sources: readonly BridgeSourcePolicy[];
  private readonly clock: () => number;
  constructor(private readonly store: CanonicalBridgeStore, options: { sources: readonly BridgeSourcePolicy[]; clock?: () => number }) {
    const sources = data(options.sources, 'BRIDGE_SOURCE_POLICY_INVALID');
    if (!Array.isArray(sources) || sources.length > 32) fail('BRIDGE_SOURCE_POLICY_INVALID');
    const seen = new Set<string>();
    for (const raw of sources) {
      const row = object(raw, ['sourceSystem', 'partition'], 'BRIDGE_SOURCE_POLICY_INVALID');
      if (typeof row.sourceSystem !== 'string' || !/^[a-z][a-z0-9._:-]{0,63}$/.test(row.sourceSystem) || !['demo', 'external'].includes(row.partition as string) || seen.has(row.sourceSystem)) fail('BRIDGE_SOURCE_POLICY_INVALID');
      seen.add(row.sourceSystem);
    }
    this.sources = sources as BridgeSourcePolicy[];
    this.clock = options.clock ?? Date.now;
  }
  private checkSource(scope: BridgeScope, command: BridgeCommand) {
    if (command.action !== 'record_source') return;
    const policy = this.sources.find(row => row.sourceSystem === command.reference.sourceSystem);
    if (!policy) fail('BRIDGE_SOURCE_NOT_ALLOWED');
    if (policy.partition !== scope.partition) fail('BRIDGE_FORBIDDEN_PARTITION');
  }
  private source(projection: Projection, id: string, kind?: BridgeSourceVersion['kind']): BridgeSourceVersion {
    const row = projection.sourceVersions.find(value => value.id === id);
    if (!row) fail('BRIDGE_REFERENCE_NOT_FOUND');
    if (kind !== undefined && row.kind !== kind) fail('BRIDGE_REFERENCE_KIND_MISMATCH');
    return row;
  }
  private checkChain(projection: Projection, bindingId: string, refs: BridgeChainReferences): void {
    if (refs.invoice !== null && refs.quote === null) fail('BRIDGE_INVALID_CHAIN');
    const lead = this.source(projection, refs.lead, 'lead');
    const event = this.source(projection, refs.event, 'event');
    const quote = refs.quote === null ? null : this.source(projection, refs.quote, 'quote');
    const invoice = refs.invoice === null ? null : this.source(projection, refs.invoice, 'invoice');
    const active = new Map<string, BridgeBindingRevision>();
    for (const row of projection.bindings) active.set(row.bindingId, row);
    for (const row of active.values()) {
      if (row.bindingId === bindingId || row.refs === null) continue;
      const other = row.refs;
      const sameOwners = this.source(projection, other.lead).entityId === lead.entityId && this.source(projection, other.event).entityId === event.entityId;
      if (quote && other.quote && this.source(projection, other.quote).entityId === quote.entityId && !sameOwners) fail('BRIDGE_LINK_CONFLICT');
      if (invoice && other.invoice && this.source(projection, other.invoice).entityId === invoice.entityId && (!sameOwners || other.quote !== refs.quote)) fail('BRIDGE_LINK_CONFLICT');
    }
  }
  private apply(scope: BridgeScope, projection: Projection, command: BridgeCommand, atMs: number, revision: number): BridgeReceipt {
    this.checkSource(scope, command);
    if (command.action === 'record_source') {
      if (command.provenance.observedAtMs > atMs) fail('BRIDGE_INVALID_COMMAND');
      const identity = entityId(scope, command.reference);
      const priorKind = projection.sourceVersions.find(row => row.entityId === identity)?.kind;
      if (priorKind !== undefined && priorKind !== command.kind) fail('BRIDGE_ENTITY_KIND_CONFLICT');
      const id = `version-${hash([identity, command.sourceVersion])}`;
      const prior = projection.sourceVersions.find(row => row.id === id);
      if (prior) {
        if (prior.contentDigest !== command.contentDigest) fail('BRIDGE_VERSION_CONFLICT');
        return { replayed: false, deduplicated: true, revision, recorded: structuredClone(prior) };
      }
      const recorded: BridgeSourceVersion = { id, entityId: identity, kind: command.kind, reference: structuredClone(command.reference), sourceVersion: command.sourceVersion, contentDigest: command.contentDigest, provenance: structuredClone(command.provenance), recordedAtMs: atMs, recordedBy: scope.actorId };
      projection.sourceVersions.push(recorded);
      return { replayed: false, deduplicated: false, revision, recorded: structuredClone(recorded) };
    }
    const history = projection.bindings.filter(row => row.bindingId === command.bindingId);
    const current = history.at(-1);
    if ((current?.revision ?? 0) !== command.expectedBindingRevision || (current?.digest ?? null) !== command.expectedBindingDigest) fail('BRIDGE_BINDING_CONFLICT');
    let refs: BridgeChainReferences | null;
    let targetRevision: number | null = null;
    if (command.action === 'bind') refs = structuredClone(command.refs);
    else {
      if (!current) fail('BRIDGE_REFERENCE_NOT_FOUND');
      if (command.action === 'unlink') refs = null;
      else {
        const target = history.find(row => row.revision === command.targetRevision);
        if (!target) fail('BRIDGE_REFERENCE_NOT_FOUND');
        refs = structuredClone(target.refs);
        targetRevision = target.revision;
      }
    }
    if (refs !== null) this.checkChain(projection, command.bindingId, refs);
    const body = { bindingId: command.bindingId, revision: (current?.revision ?? 0) + 1, previousDigest: current?.digest ?? null, action: command.action, refs, targetRevision, evidenceRef: command.evidenceRef, recordedAtMs: atMs, recordedBy: scope.actorId };
    const recorded: BridgeBindingRevision = { ...body, digest: hash([scope, body]) };
    projection.bindings.push(recorded);
    return { replayed: false, deduplicated: false, revision, recorded: structuredClone(recorded) };
  }
  private async load(scope: BridgeScope): Promise<{ casRevision: number | null; ledger: Ledger; projection: Projection }> {
    let stored: Awaited<ReturnType<CanonicalBridgeStore['read']>>;
    try { stored = await this.store.read(workspaceKey(scope)); } catch { return fail('BRIDGE_STORE_UNAVAILABLE'); }
    if (stored === null) return { casRevision: null, ledger: { schemaVersion: 1, scope, revision: 0, events: [] }, projection: { sourceVersions: [], bindings: [] } };
    try {
      const row = object(data(stored, 'BRIDGE_STATE_INVALID'), ['revision', 'value'], 'BRIDGE_STATE_INVALID');
      if (!integer(row.revision, 1)) fail('BRIDGE_STATE_INVALID');
      const body = object(row.value, ['schemaVersion', 'scope', 'revision', 'events'], 'BRIDGE_STATE_INVALID');
      if (body.schemaVersion !== 1 || !same(scopeInput(body.scope), scope) || !integer(body.revision, 1) || !Array.isArray(body.events) || body.events.length !== body.revision || body.events.length > MAX_EVENTS) fail('BRIDGE_STATE_INVALID');
      const projection: Projection = { sourceVersions: [], bindings: [] };
      const commands = new Set<string>();
      let previousDigest: string | null = null;
      let previousTime = 0;
      for (let index = 0; index < body.events.length; index++) {
        const event = object(body.events[index], ['command', 'atMs', 'receipt', 'previousDigest', 'digest'], 'BRIDGE_STATE_INVALID');
        const command = commandInput(event.command);
        if (command.expectedRevision !== index || commands.has(command.idempotencyKey) || !time(event.atMs) || event.atMs < previousTime || event.previousDigest !== previousDigest) fail('BRIDGE_STATE_INVALID');
        const receipt = this.apply(scope, projection, command, event.atMs, index + 1);
        const expectedDigest = hash([scope, command, event.atMs, receipt, previousDigest]);
        if (!same(receipt, event.receipt) || event.digest !== expectedDigest) fail('BRIDGE_STATE_INVALID');
        commands.add(command.idempotencyKey);
        previousDigest = expectedDigest;
        previousTime = event.atMs;
      }
      return { casRevision: row.revision, ledger: body as Ledger, projection };
    } catch { return fail('BRIDGE_STATE_INVALID'); }
  }
  async execute(rawScope: BridgeScope, rawCommand: unknown): Promise<BridgeReceipt> {
    const scope = scopeInput(rawScope);
    const command = commandInput(rawCommand);
    this.checkSource(scope, command);
    const { casRevision, ledger, projection } = await this.load(scope);
    const previous = ledger.events.find(row => row.command.idempotencyKey === command.idempotencyKey);
    if (previous) {
      if (!same(previous.command, command)) fail('BRIDGE_IDEMPOTENCY_CONFLICT');
      return { ...structuredClone(previous.receipt), replayed: true };
    }
    if (command.expectedRevision !== ledger.revision) fail('BRIDGE_REVISION_CONFLICT');
    if (ledger.events.length >= MAX_EVENTS) fail('BRIDGE_LIMIT');
    let atMs: number;
    try { atMs = this.clock(); } catch { return fail('BRIDGE_INVALID_CLOCK'); }
    if (!time(atMs) || atMs < (ledger.events.at(-1)?.atMs ?? 0)) fail('BRIDGE_INVALID_CLOCK');
    const receipt = this.apply(scope, projection, command, atMs, ledger.revision + 1);
    const previousDigest = ledger.events.at(-1)?.digest ?? null;
    const event: Event = { command, atMs, receipt, previousDigest, digest: hash([scope, command, atMs, receipt, previousDigest]) };
    ledger.events.push(event);
    ledger.revision = receipt.revision;
    // Bound the aggregate before committing. A failed CAS never rebases a link.
    data(ledger, 'BRIDGE_LIMIT');
    let committed: boolean;
    try { committed = await this.store.compareAndSet(workspaceKey(scope), casRevision, ledger); } catch { return fail('BRIDGE_STORE_UNAVAILABLE'); }
    if (!committed) fail('BRIDGE_REVISION_CONFLICT');
    return structuredClone(receipt);
  }
  async snapshot(rawScope: BridgeScope): Promise<BridgeSnapshot> {
    const scope = scopeInput(rawScope);
    const { ledger, projection } = await this.load(scope);
    return structuredClone({ schemaVersion: 1, scope, revision: ledger.revision, ...projection });
  }
  async resolve(rawScope: BridgeScope, sourceVersionId: string): Promise<BridgeBindingRevision | null> {
    const scope = scopeInput(rawScope);
    if (!token(sourceVersionId)) fail('BRIDGE_INVALID_COMMAND');
    const { projection } = await this.load(scope);
    this.source(projection, sourceVersionId);
    const active = new Map<string, BridgeBindingRevision>();
    for (const row of projection.bindings) active.set(row.bindingId, row);
    const matches = [...active.values()].filter(row => row.refs !== null && Object.values(row.refs).includes(sourceVersionId));
    if (matches.length > 1) fail('BRIDGE_AMBIGUOUS_LINK');
    return structuredClone(matches[0] ?? null);
  }
  async readBinding(rawScope: BridgeScope, bindingId: string, revision: number): Promise<BridgeBindingRevision> {
    const scope = scopeInput(rawScope);
    if (!token(bindingId) || !integer(revision, 1)) fail('BRIDGE_INVALID_COMMAND');
    const { projection } = await this.load(scope);
    const row = projection.bindings.find(value => value.bindingId === bindingId && value.revision === revision);
    if (!row) fail('BRIDGE_REFERENCE_NOT_FOUND');
    return structuredClone(row);
  }
}

// The durable adapter shares the service's complete replay validation. This
// validates data integrity and scope, never provider authenticity or outcomes.
export async function validateCanonicalBridgeStoredValue(key: string, value: unknown, options: { sources: readonly BridgeSourcePolicy[] }): Promise<ValidatedCanonicalBridgeValue> {
  try {
    const detached = data(value, 'BRIDGE_STATE_INVALID');
    const body = object(detached, ['schemaVersion', 'scope', 'revision', 'events'], 'BRIDGE_STATE_INVALID');
    const scope = scopeInput(body.scope);
    if (workspaceKey(scope) !== key) fail('BRIDGE_STATE_INVALID');
    const store: CanonicalBridgeStore = {
      async read() { return { revision: 1, value: detached }; },
      async compareAndSet() { return fail('BRIDGE_STATE_INVALID'); },
    };
    await new CanonicalBridge(store, options).snapshot(scope);
    const ledger = detached as Ledger;
    const last = ledger.events.at(-1)!;
    return structuredClone({ scope, revision: ledger.revision, events: ledger.events, lastDigest: last.digest, lastAtMs: last.atMs, value: detached });
  } catch { return fail('BRIDGE_STATE_INVALID'); }
}
