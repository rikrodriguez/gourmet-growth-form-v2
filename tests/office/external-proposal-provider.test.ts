import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ExternalProposalError, readProposalDocument, snapshotProposalDocument, verifyProposalDocument } from '../../src/office/backend/external-proposal-provider';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { createExistingProposalSessionResolver } from '../../src/office/backend/proposal-host-session';
import { EventQuoteError } from '../../src/office/backend/event-quote-contracts';
import { proposalFixture } from './external-proposal-fixtures';
import { durableProposalFixture } from './external-proposal-durable-fixtures';
async function sample() {
 const f = await proposalFixture(), document = f.documents.get(f.targets[0].proposalId)!;
 return { document, context: { target: f.targets[0], scope: document.scope, source: f.authorities.get(f.targets[0].leadId)!.source } };
}
test('provider contract hashes exact UTF-8 with a known vector and detaches both context and returned content', async () => {
 const { document, context } = await sample(); document.content = 'abc';
 const result = await readProposalDocument({ async read(selected) { selected.eventId = 'MUTATED'; return document; } }, context);
 assert.equal(result.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); assert.equal(result.referenceOnly, false);
 document.content = 'changed'; context.target.eventId = 'changed';
 assert.equal(result.document.content, 'abc'); assert.equal(result.document.eventId, 'SYNTHETIC-EVENT-a');
 const a = verifyProposalDocument({ ...result.document, content: '\u00e1' }, { ...context, target: result.document });
 const b = verifyProposalDocument({ ...result.document, content: 'a\u0301' }, { ...context, target: result.document });
 assert.notEqual(a.sha256, b.sha256); // No Unicode or line-ending normalization.
});
test('missing provider is explicit and null content remains reference_only, without fetching its historical URL', async () => {
 const { document, context } = await sample();
 await assert.rejects(readProposalDocument(undefined, context), (e: unknown) => e instanceof ExternalProposalError && e.code === 'PROVIDER_REQUIRED');
 const value = await readProposalDocument({ async read() { return { ...document, content: null }; } }, context);
 assert.equal(value.referenceOnly, true); assert.equal(value.sha256, null); assert.equal(value.document.content, null);
});
test('untrusted provider fields, IDs, scope, version, text encoding and provenance fail closed', async () => {
 const { document, context } = await sample();
 for (const patch of [
  { provider: 'hostinger' }, { leadId: 'OTHER' }, { eventId: 'OTHER' }, { proposalId: 'OTHER' },
  { scope: { ...document.scope, workspaceId: 'OTHER' } }, { scope: { ...document.scope, mode: 'commercial' } },
  { sourceVersion: '' }, { content: '' }, { content: ' '.repeat(8) }, { content: '\ud800' }, { content: 'é'.repeat(131073) },
  { content: undefined }, { sha256: 'a'.repeat(64) }, { historicalLink: { ...document.historicalLink, provenance: { ...document.historicalLink.provenance, itemId: 'OTHER' } } },
  { historicalLink: { ...document.historicalLink, provenance: { ...document.historicalLink.provenance, columnId: 'link_mm5gbcxh' } } },
 ]) assert.throws(() => verifyProposalDocument({ ...document, ...patch }, context), ExternalProposalError);
});
test('provider getters and serialization hooks cannot execute while snapshotting document data', async () => {
 const { document, context } = await sample(); let invoked = 0;
 const contentGetter = { ...document }; Object.defineProperty(contentGetter, 'content', { enumerable: true, get() { invoked++; return 'abc'; } });
 assert.throws(() => verifyProposalDocument(contentGetter, context), ExternalProposalError);
 const historyGetter = structuredClone(document); Object.defineProperty(historyGetter.historicalLink.provenance, 'accountId', { enumerable: true, get() { invoked++; return 'demo-account'; } });
 assert.throws(() => verifyProposalDocument(historyGetter, context), ExternalProposalError);
 assert.throws(() => snapshotProposalDocument({ ...document, toJSON() { invoked++; return document; } }), ExternalProposalError);
 assert.equal(invoked, 0);
});
test('authorized provider import persists an immutable version, recovers and replays without another source revision', async () => {
 const f = await durableProposalFixture();
 try {
  const proof = await createExistingProposalSessionResolver({ target: f.target, owner: { readExistingSession: () => ({ proof: f.proof, scope: f.scope, actorId: f.actorId, target: f.target, expiresAtMs: f.at + 60000 }) } })({});
  const associated = await f.service.execute(proof, { action: 'associate', key: 'provider-a', expectedRevision: 0 });
  await f.service.execute(proof, { action: 'approve', key: 'provider-review', expectedRevision: 1, reviewKey: associated.snapshot!.reviewKey });
  const document = { ...f.document, sourceVersion: 'v2', content: 'Contenido exacto importado del proveedor sintético.' };
  let reads = 0; const provider = { async read() { reads++; return document; } };
  await f.service.publishFromProvider(proof, provider); const stored = await f.service.history(proof);
  assert.equal((await f.service.read(proof)).status, 'obsolete'); assert.equal(stored!.documents.length, 2);
  const restarted = createDurableTestProposalService(f); await restarted.publishFromProvider(proof, provider);
  const recovered = await restarted.history(proof); assert.deepEqual(recovered, stored); assert.equal(reads, 2);
  await assert.rejects(restarted.publishFromProvider(proof, { async read() { return { ...document, content: 'Contenido alterado bajo v2' }; } }), (e: unknown) => e instanceof EventQuoteError && e.code === 'VERSION_CONFLICT');
  assert.deepEqual(await restarted.history(proof), stored);
  await assert.rejects(restarted.publishFromProvider(proof), (e: unknown) => e instanceof EventQuoteError && e.code === 'PROVIDER_REQUIRED');
 } finally { await f.close(); }
});
test('reference-only import cannot receive documentary approval and failed import leaves source/history unchanged', async () => {
 const f = await durableProposalFixture();
 try {
  const before = await f.service.history(f.proof);
  await assert.rejects(f.service.publishFromProvider(f.proof, { async read() { return { ...f.document, eventId: 'OTHER' }; } }));
  assert.deepEqual(await f.service.history(f.proof), before);
  await f.service.publishFromProvider(f.proof, { async read() { return { ...f.document, sourceVersion: 'v2', content: null }; } });
  const view = await f.service.execute(f.proof, { action: 'associate', key: 'reference-only', expectedRevision: 0 }); assert.equal(view.status, 'reference_only');
  await assert.rejects(f.service.execute(f.proof, { action: 'approve', key: 'no-document', expectedRevision: 1, reviewKey: view.snapshot!.reviewKey }));
  const after = await f.service.history(f.proof); assert.equal(after!.record!.approvals.length, 0); assert.equal(after!.record!.receipts.length, 1);
 } finally { await f.close(); }
});
test('host expiry during provider I/O rolls back the entire import while SQL session is still valid', async () => {
 const f = await durableProposalFixture();
 try {
  const expiresAtMs = f.at + 1000;
  const proof = await createExistingProposalSessionResolver({ target: f.target, clock: () => f.at, owner: { readExistingSession: () => ({ proof: f.proof, scope: f.scope, actorId: f.actorId, target: f.target, expiresAtMs }) } })({});
  const before = await f.service.history(f.proof);
  await assert.rejects(f.service.publishFromProvider(proof, { async read() { f.setClock(expiresAtMs); return { ...f.document, sourceVersion: 'v2', content: 'Must roll back' }; } }), (e: unknown) => e instanceof EventQuoteError && e.code === 'ACCESS_DENIED');
  f.setClock(f.at); assert.deepEqual(await f.service.history(f.proof), before);
 } finally { await f.close(); }
});
test('normal servers never install the host resolver or document import, and the shared contract has no URL I/O', async () => {
 for (const file of ['src/office/main.tsx', 'src/office/backend/http.ts', 'src/office/backend/server.ts', 'src/office/backend/staging-app.ts', 'src/office/backend/staging-server.ts']) {
  assert.doesNotMatch(await readFile(file, 'utf8'), /createExistingProposalSessionResolver|publishFromProvider|createTestProposalApi/);
 }
 assert.doesNotMatch(await readFile('src/office/backend/external-proposal-provider.ts', 'utf8'), /\bfetch\(|\bhttps?\.|\biframe\b/);
});
