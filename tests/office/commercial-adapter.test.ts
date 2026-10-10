import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OfficeReadError, executeDemoCommand, validateOfficeSnapshot } from '../../src/office/adapter';
import { createOfficeFixtureState } from '../../src/office/backend/fixtures';
import { projectOfficeSnapshot } from '../../src/office/backend/state';
import type { CommercialThread, OfficeCommand, OfficeSnapshot } from '../../src/office/contracts';

const AT = Date.parse('2026-10-10T21:00:00.000Z');
function input(): OfficeSnapshot {
  const snapshot = projectOfficeSnapshot(createOfficeFixtureState(AT), AT);
  const ev = { source: 'fixture:office-demo', at: new Date(AT).toISOString(), simulated: true, reference: 'demo:demo-aurora:commercial-adapter-fixture' };
  const thread: CommercialThread = {
    schemaVersion: 1, id: 'commercial-aurora-test', caseId: 'demo-aurora', revision: 1, digest: 'a'.repeat(64),
    subject: 'Solicitud inventada de una cena de equipo', recipient: 'contacto-demo@invalid.test', evidence: ev,
    messages: [{ id: 'message-commercial-test', author: 'Contacto sintético', text: '¿Podemos revisar un menú inventado para doce personas?', at: ev.at }],
    references: [
      { id: 'reference-fixture', source: 'fixture', status: 'simulated', label: 'Hilo inventado', detail: 'Fixture local completamente sintético.', evidence: ev },
      { id: 'reference-gmail', source: 'gmail', status: 'missing', label: 'Gmail', detail: 'Cuenta no conectada.', evidence: null },
      { id: 'reference-monday', source: 'monday', status: 'missing', label: 'Monday', detail: 'Brief real no disponible.', evidence: null },
    ],
  };
  snapshot.cases[0].commercialThreads = [thread];
  const approval = snapshot.cases[0].approvals[0];
  approval.functionId = 'sales'; approval.recipient = thread.recipient; approval.commercialContext = structuredClone(thread);
  return snapshot;
}
function incompatible(value: OfficeSnapshot) {
  assert.throws(() => validateOfficeSnapshot(value, 'demo'), (error: unknown) => error instanceof OfficeReadError && error.code === 'incompatible');
}

describe('commercial input read boundary', () => {
  it('accepts explicit synthetic thread/context and preserves legacy optional-field absence', () => {
    const snapshot = input();
    assert.deepEqual(validateOfficeSnapshot(snapshot, 'demo'), snapshot);
    for (const item of snapshot.cases) {
      delete item.commercialThreads;
      for (const row of item.approvals) delete row.commercialContext;
    }
    assert.deepEqual(validateOfficeSnapshot(snapshot, 'demo'), snapshot);
  });

  it('rejects foreign cases, real recipients, malformed versions and unverified provenance', () => {
    const changes: Array<(thread: CommercialThread) => void> = [
      thread => { thread.caseId = 'demo-cedar'; },
      thread => { thread.recipient = 'contacto@example.com'; },
      thread => { thread.digest = 'unverified'; },
      thread => { thread.revision = 0; },
      thread => { thread.evidence.simulated = false; },
      thread => { thread.evidence.reference = 'demo:demo-cedar:foreign-thread'; },
      thread => { thread.messages = []; },
      thread => { thread.messages[0].at = '2026-02-30T00:00:00.000Z'; },
      thread => { thread.references[1].evidence = thread.evidence; },
      thread => { thread.references[0].evidence = null; },
      thread => { thread.references.push(structuredClone(thread.references[0])); },
      thread => { Object.assign(thread, { externalUrl: 'https://example.com' }); },
    ];
    for (const change of changes) {
      const snapshot = input(); change(snapshot.cases[0].commercialThreads![0]); incompatible(snapshot);
    }
  });

  it('rejects approval context attached to another function, recipient or case', () => {
    const wrongFunction = input(); wrongFunction.cases[0].approvals[0].functionId = 'finance'; incompatible(wrongFunction);
    const wrongRecipient = input(); wrongRecipient.cases[0].approvals[0].recipient = 'otro-demo@invalid.test'; incompatible(wrongRecipient);
    const foreignContext = input(); foreignContext.cases[0].approvals[0].commercialContext!.caseId = 'demo-harbor'; incompatible(foreignContext);
  });

  it('sends only a complete sales draft thread binding and rejects extra content before requesting', async t => {
    const originalFetch = globalThis.fetch;
    const requests: unknown[] = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ snapshot: input(), replayed: false }), { headers: { 'content-type': 'application/json' } });
    };
    t.after(() => { globalThis.fetch = originalFetch; });
    const command: OfficeCommand = {
      idempotencyKey: 'commercial-adapter-command', caseId: 'demo-aurora', functionId: 'sales', action: 'draft',
      commercialThreadId: 'commercial-aurora-test', commercialThreadRevision: 1, commercialThreadDigest: 'a'.repeat(64),
    };
    const malformed: Record<string, unknown>[] = [
      { ...command, commercialThreadId: undefined },
      { ...command, commercialThreadRevision: undefined },
      { ...command, commercialThreadDigest: undefined },
      { ...command, commercialThreadId: 'constructor' },
      { ...command, commercialThreadRevision: 0 },
      { ...command, commercialThreadDigest: 'unverified' },
      { ...command, functionId: 'finance' },
      { ...command, action: 'chat', text: 'consulta' },
      { ...command, text: undefined },
      { ...command, text: 'contenido cambiado por el cliente' },
      { ...command, commercialContext: input().cases[0].commercialThreads![0] },
      { ...command, recipient: 'other@invalid.test' },
    ];
    const partial = { ...command }; delete partial.commercialThreadDigest; malformed.push(partial);
    for (const value of malformed) {
      await assert.rejects(executeDemoCommand(value as unknown as OfficeCommand), (error: unknown) => error instanceof OfficeReadError && error.code === 'validation');
    }
    assert.equal(requests.length, 0);
    assert.equal((await executeDemoCommand(command)).replayed, false);
    assert.deepEqual(requests, [command]);
  });
});
