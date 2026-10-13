import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AttachmentList, CommunicationsField, CommunicationsHistory, CommunicationsPage, CommunicationsSessionState, SavedDraftReview, SourceSnapshotCard } from '../../src/office/CommunicationsPage';
import { communicationsClient, CommunicationsClientError, draftBlockReason, followUpAllowed, latestDrafts, validateCommunicationsReview, verifyDraftContext } from '../../src/office/communications-client';
import { createCommunicationsWorkflow } from '../../src/office/backend/communications';
import { communicationsFixtureObservations } from '../../src/office/backend/communications-fixture';
import type { CommunicationsReviewView } from '../../src/office/communications-api-contracts';
import type { CommunicationsStoredRecord, CommunicationsStore, ExactDraft, Observation } from '../../src/office/backend/communications-contracts';

const AT = 1_791_806_400_000;
async function setup(index = 0, extra: Partial<ExactDraft> = {}) {
  let record: CommunicationsStoredRecord | null = null;
  const store: CommunicationsStore = { async read() { return structuredClone(record); }, async compareAndSet(expected, ledger) { if (expected !== (record?.revision ?? null)) return false; record = { revision: (record?.revision ?? 0) + 1, ledger: structuredClone(ledger) }; return true; } };
  const workflow = createCommunicationsWorkflow({ scope: { organizationId: 'fixture-org', actorId: 'fixture-actor', partition: 'external', dataMode: 'fixture' }, store, clock: () => AT });
  for (const observation of communicationsFixtureObservations(AT)) await workflow.recordObservation({ expectedRevision: (await workflow.view()).revision, observation });
  let value = await workflow.view();
  value = await workflow.link({ expectedRevision: value.revision, id: 'association-ui', ...value.candidates[index], explicit: true, ambiguityAcknowledged: true, evidenceRef: 'fixture:explicit-human-review' });
  const lead = value.snapshots.find(s => s.id === value.associations[0].leadSnapshotId)!;
  assert.equal(lead.kind, 'lead');
  const input = { id: 'draft-ui', associationId: 'association-ui', purpose: 'reply', to: [lead.kind === 'lead' ? lead.data.email! : ''], cc: [], bcc: [], subject: 'Mensaje sintético exacto', bodyText: 'Texto sintético exacto.', bodyHtml: null, attachments: [], ...extra };
  value = await workflow.saveDraft({ expectedRevision: value.revision, ...input });
  const result = (workflowView = value): CommunicationsReviewView => ({ mode: 'fixture', session: { mode: 'fixture', actorId: 'fixture-actor', organizationId: 'fixture-org', csrfToken: 'c'.repeat(64), expiresAt: '2099-01-01T00:00:00.000Z', storage: 'ephemeral', outboundEffects: 0 }, workflow: workflowView });
  return { workflow, value, result, input };
}
const noop = () => {};

test('communications page starts with a read, never an implicit fixture-session write', () => {
  const html = renderToStaticMarkup(<CommunicationsPage />);
  assert.match(html, /Consultando la sesión local/);
  assert.match(html, /Datos sintéticos/);
  assert.match(html, /0 envíos/);
  assert.doesNotMatch(html, /communications-start-session/);
});

test('session states explain explicit start, disabled service, expiry and unknown outcome', () => {
  for (const phase of ['signed_out', 'expired', 'disabled', 'unavailable', 'loading'] as const) {
    const html = renderToStaticMarkup(<CommunicationsSessionState phase={phase} busy={null} error={null} onStart={noop} onRefresh={noop} />);
    assert.equal(html.includes('communications-start-session'), phase === 'signed_out' || phase === 'expired');
    if (phase === 'disabled') assert.match(html, /habilitado explícitamente/);
    if (phase === 'expired') assert.match(html, /ya no se puede recuperar/);
    if (phase === 'unavailable') assert.match(html, /Ninguna acción se reintentará automáticamente/);
  }
});

test('fixture view shows separated account identity, provenance, session limits and disabled approval by default', async () => {
  const t = await setup(); const html = renderToStaticMarkup(<CommunicationsPage initialView={t.result()} />);
  assert.match(html, /Felipe/); assert.match(html, /Info/);
  assert.match(html, /felipe@example.test/); assert.match(html, /info@example.test/);
  assert.match(html, /fixture-board/); assert.match(html, /fixture-aurora-felipe/);
  assert.match(html, /Almacenamiento efímero/); assert.match(html, /Una nueva sesión abre una muestra nueva/);
  assert.doesNotMatch(html, new RegExp(t.result().session.csrfToken));
  assert.equal((html.match(/data-testid="communications-candidate-choice"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /type="radio"[^>]*checked=""/);
  assert.match(html, /data-testid="communications-create-draft"[^>]*disabled=""|disabled=""[^>]*data-testid="communications-create-draft"/);
  assert.doesNotMatch(html, /data-testid="communications-approve"/);
  const persisted = t.result(); persisted.session.storage = 'postgres';
  const persistedHtml = renderToStaticMarkup(<CommunicationsPage initialView={persisted} />);
  assert.match(persistedHtml, /Almacenamiento PostgreSQL local/); assert.match(persistedHtml, /incluso si siguen en PostgreSQL/);
});

test('exact draft and source text is escaped, including HTML and attachment names', async () => {
  const hostile = '<img src="https://external.invalid/pixel" onerror="alert(1)"><script>alert(2)</script>';
  const t = await setup(0, { subject: hostile, bodyText: `</pre>${hostile}`, bodyHtml: hostile, attachments: [{ id: 'attachment-ui', filename: hostile.slice(0, 200), mimeType: 'text/html', sha256: 'a'.repeat(64) }] });
  const d = t.value.drafts.at(-1)!;
  const html = renderToStaticMarkup(<SavedDraftReview draft={d} workflow={t.value} />);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<img|<script|<iframe/);
  assert.match(html, /Para \(To\)/); assert.match(html, /CCO \(BCC\)/); assert.match(html, new RegExp(d.digest));
  const source = structuredClone(t.value.snapshots.find(s => s.kind === 'thread')!);
  if (source.kind === 'thread') { source.data.messages[0].bodyText = hostile; source.data.messages[0].subject = hostile; }
  const sourceHtml = renderToStaticMarkup(<SourceSnapshotCard source={source} />);
  assert.match(sourceHtml, /&lt;img/); assert.doesNotMatch(sourceHtml, /<img|<script/);
});

test('HTML absence and unknown attachment hashes are explicit', async () => {
  const t = await setup(0, { attachments: [{ id: 'attachment-ui', filename: 'invoice.pdf', mimeType: 'application/pdf', sha256: null }] });
  const d = t.value.drafts.at(-1)!;
  assert.match(renderToStaticMarkup(<SavedDraftReview draft={d} workflow={t.value} />), /Sin versión HTML/);
  assert.match(renderToStaticMarkup(<AttachmentList attachments={d.attachments} />), /Sin hash verificado/);
  assert.match(draftBlockReason(t.value, d)!, /adjuntos sin hash verificado/);
  assert.match((await verifyDraftContext(t.value, d))!, /adjuntos sin hash verificado/);
});

test('client preflight accepts authentic exact draft content and blocks tampered text, recipients, HTML and attachments', async () => {
  const t = await setup(0, { attachments: [{ id: 'attachment-ui', filename: 'example.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64) }] });
  const d = t.value.drafts.at(-1)!;
  assert.equal(await verifyDraftContext(t.value, d), null);
  for (const mutate of [
    (draft: ExactDraft) => { draft.bodyText = 'Different displayed text'; },
    (draft: ExactDraft) => { draft.to = ['someone-else@example.test']; },
    (draft: ExactDraft) => { draft.bcc = ['hidden@example.test']; },
    (draft: ExactDraft) => { draft.subject = 'Different subject'; },
    (draft: ExactDraft) => { draft.bodyHtml = '<p>Different HTML</p>'; },
    (draft: ExactDraft) => { draft.attachments[0].filename = 'different.pdf'; },
    (draft: ExactDraft) => { draft.attachments[0].sha256 = 'b'.repeat(64); },
  ]) { const changed = structuredClone(t.value); mutate(changed.drafts[0]); assert.match((await verifyDraftContext(changed, changed.drafts[0]))!, /contenido mostrado no coincide/); }
});

test('client preflight detects context changes not represented by the association current flag', async () => {
  const t = await setup();
  const voice: Observation = { kind: 'voice', source: 'voice_notification', sourceKey: 'felipe:fixture-felipe:notification-ui', providerVersion: 'voice-v1', observedAtMs: AT, data: { mailbox: 'felipe', accountId: 'fixture-felipe', contactEmail: 'aurora@example.test', notificationId: 'notification-ui', incomingText: 'Nueva evidencia parcial sintética.', coverage: { scope: 'incoming_notifications', incoming: 'partial', outgoing: 'unknown' } } };
  const updated = await t.workflow.recordObservation({ expectedRevision: t.value.revision, observation: voice });
  assert.equal(updated.associationStates[0].current, true);
  assert.match((await verifyDraftContext(updated, updated.drafts[0]))!, /fuentes o su cobertura cambiaron/);
});

test('follow-up requires complete correspondence and old revisions cannot be approved', async () => {
  const partial = await setup(0); assert.equal(followUpAllowed(partial.value, partial.value.associations[0]), false);
  const complete = await setup(2); assert.equal(followUpAllowed(complete.value, complete.value.associations[0]), true);
  const old = complete.value.drafts[0];
  const updated = await complete.workflow.saveDraft({ expectedRevision: complete.value.revision, ...complete.input, bodyText: 'Revision two' });
  assert.equal(latestDrafts(updated).length, 1); assert.equal(latestDrafts(updated)[0].revision, 2);
  assert.match(draftBlockReason(updated, old)!, /revisión más reciente/);
});

test('history renders approved_unsent, stale and disabled dispatch without claiming delivery', async () => {
  const t = await setup(); const d = t.value.drafts[0];
  const approved = await t.workflow.approve({ expectedRevision: t.value.revision, id: 'approval-ui', draftId: d.id, draftRevision: d.revision, draftDigest: d.digest });
  const approvedHtml = renderToStaticMarkup(<CommunicationsHistory workflow={approved} />);
  assert.match(approvedHtml, /approved_unsent/); assert.match(approvedHtml, /Aprobado, sin enviar/); assert.match(approvedHtml, /Desactivado/);
  const changed = await t.workflow.saveDraft({ expectedRevision: approved.revision, ...t.input, bodyText: 'Changed after exact approval' });
  const staleHtml = renderToStaticMarkup(<CommunicationsHistory workflow={changed} />);
  assert.match(staleHtml, /Obsoleto, sin enviar/); assert.match(staleHtml, /stale/);
  assert.match(staleHtml, /0 envíos/);
});

test('runtime response contract refuses live modes, enabled dispatch, malformed data and impossible timestamps', async () => {
  const t = await setup();
  assert.deepEqual(validateCommunicationsReview(t.result()), t.result());
  for (const mutate of [
    (view: any) => { view.mode = 'live'; },
    (view: any) => { view.session.mode = 'live'; },
    (view: any) => { view.session.outboundEffects = 1; },
    (view: any) => { view.session.csrfToken = 'short'; },
    (view: any) => { view.workflow.outboundEffects = 1; },
    (view: any) => { view.workflow.snapshots[0].observedAtMs = Number.MAX_SAFE_INTEGER; },
    (view: any) => { view.workflow.drafts[0].digest = 'wrong'; },
    (view: any) => { view.workflow.drafts[0].bcc = 'someone@example.test'; },
    (view: any) => { view.workflow.unexpected = true; },
  ]) { const changed = structuredClone(t.result()); mutate(changed); assert.throws(() => validateCommunicationsReview(changed), CommunicationsClientError); }
});

test('browser client uses only same-origin exact endpoints, JSON and CSRF without automatic retries', async t => {
  const fixture = await setup(); const calls: { url: string; init: RequestInit }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(fixture.result()), { headers: { 'content-type': 'application/json' } }); });
  const signal = new AbortController().signal;
  await communicationsClient.start(signal);
  assert.equal(calls[0].url, '/office-api/communications/session'); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.body, '{}');
  await communicationsClient.read(signal); assert.equal(calls[1].init.method, 'GET');
  const d = fixture.value.drafts[0]; const approval = { expectedRevision: fixture.value.revision, id: 'approval-ui', draftId: d.id, draftRevision: d.revision, draftDigest: d.digest };
  await communicationsClient.approve(approval, fixture.result().session.csrfToken, signal);
  assert.equal(calls[2].url, '/office-api/communications/approvals');
  assert.equal((calls[2].init.headers as Record<string, string>)['x-communications-csrf'], fixture.result().session.csrfToken);
  assert.deepEqual(JSON.parse(calls[2].init.body as string), approval);
  for (const call of calls) { assert.equal(call.init.credentials, 'same-origin'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.cache, 'no-store'); }
  t.mock.method(globalThis, 'fetch', async () => { calls.push({ url: 'failed', init: {} }); throw new TypeError('connection dropped'); });
  await assert.rejects(communicationsClient.approve(approval, fixture.result().session.csrfToken, signal), (error: unknown) => error instanceof CommunicationsClientError && error.code === 'request_uncertain');
  assert.equal(calls.length, 4);
});

test('transport honors 512 KiB draft payloads, rejects oversized UTF-8 bodies and handles 401/409 safely', async t => {
  const fixture = await setup(); let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(fixture.result()), { headers: { 'content-type': 'application/json' } }); });
  const signal = new AbortController().signal; const input = { expectedRevision: fixture.value.revision, ...fixture.input } as any;
  await communicationsClient.save({ ...input, bodyText: 'a'.repeat(20_000) }, 'c'.repeat(64), signal); assert.equal(calls, 1);
  await assert.rejects(communicationsClient.save({ ...input, bodyText: '🍊'.repeat(150_000) }, 'c'.repeat(64), signal), (error: unknown) => error instanceof CommunicationsClientError && error.status === 413); assert.equal(calls, 1);
  for (const [status, error] of [[401, 'COMMUNICATIONS_SESSION_REQUIRED'], [409, 'revision_conflict']] as const) {
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json' } }); });
    await assert.rejects(communicationsClient.read(signal), (failure: unknown) => failure instanceof CommunicationsClientError && failure.status === status && failure.code === error);
  }
  assert.equal(calls, 3);
});


test('explicit field labels stay separate from prefilled textarea and select content', () => {
  for (const [id, label, control] of [
    ['communications-body-text', 'Texto del mensaje', <textarea value="Texto ya guardado" onChange={noop} />],
    ['communications-body-html', 'HTML del mensaje (no se renderiza)', <textarea value="<p>HTML guardado</p>" onChange={noop} />],
    ['communications-purpose', 'Propósito', <select value="reply" onChange={noop}><option value="reply">Respuesta</option><option value="follow_up" disabled>Seguimiento</option></select>],
    ['communications-saved-revision', 'Revisión guardada', <select value="revision-1" onChange={noop}><option value="revision-1">Asunto guardado · revisión 1</option></select>],
  ] as const) {
    const markup = renderToStaticMarkup(<CommunicationsField id={id} label={label}>{control}</CommunicationsField>);
    const labels = [...markup.matchAll(/<label for="([^"]+)">([^<]*)<\/label>/g)];
    assert.equal(labels.length, 1);
    assert.equal(labels[0][1], id);
    assert.equal(labels[0][2], label);
    assert.match(markup, new RegExp(`</label><(?:textarea|select)[^>]* id="${id}"`));
    assert.equal((markup.match(new RegExp(` id="${id}"`, 'g')) ?? []).length, 1);
    assert.doesNotMatch(markup, /<label[^>]*>[^<]*<(?:textarea|select)/);
  }
});

test('real revision and association selectors have explicit stable label-control associations', async () => {
  const t = await setup();
  const markup = renderToStaticMarkup(<CommunicationsPage initialView={t.result()} />);
  for (const [id, label, testId] of [
    ['communications-association', 'Vínculo vigente para el borrador', 'communications-association-select'],
    ['communications-saved-revision', 'Revisión guardada', 'communications-saved-select'],
  ]) {
    assert.ok(markup.includes(`<label for="${id}">${label}</label><select`));
    assert.match(markup, new RegExp(`<select[^>]*data-testid="${testId}"[^>]*id="${id}"`));
    assert.equal((markup.match(new RegExp(` id="${id}"`, 'g')) ?? []).length, 1);
  }
});
