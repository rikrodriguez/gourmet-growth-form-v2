import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventWorkspace } from '../../src/office/dashboard/EventWorkspace';
import {
  EVENT_FIXTURE, EVENT_TABS, canApproveSimulation, createEventWorkflowState, eventWorkflowReducer,
  exactReviewSnapshot, hasCurrentApproval, isExpectedProposalArtifact, isExpectedPreviewArtifact, normalizeProposalArtifact, proposalArtifactIdentity, paymentScenarioView, PROPOSAL_PDF_EXTRACTED_TEXT,
  type DraftField, type EventWorkflowAction, type EventWorkflowState,
} from '../../src/office/dashboard/event-workflow';

const artifact = { ...EVENT_FIXTURE.attachment, href: '/office/assets/DEMO-EVT-042-propuesta-v2.pdf', previewHref: '/office/assets/DEMO-EVT-042-propuesta-v2-page-1.png', previewSha256: EVENT_FIXTURE.preview.sha256, previewByteLength: EVENT_FIXTURE.preview.byteLength };
const reduce = eventWorkflowReducer;
function attested() {
  let state = createEventWorkflowState(true, artifact);
  for (const field of ['metadata', 'content', 'context'] as const) state = reduce(state, { type: 'ATTEST', field, checked: true });
  return state;
}
const approved = () => reduce(attested(), { type: 'APPROVE_SIMULATION' });
function closed() {
  let state = reduce(approved(), { type: 'HANDOFF_SIMULATION' });
  return reduce(state, { type: 'CLOSE_SALE_SIMULATION' });
}
const PAYMENT_ACTIONS: EventWorkflowAction[] = [
  { type: 'PREPARE_PAYMENT' }, { type: 'REVIEW_PAYMENT' }, { type: 'CREATE_PAYMENT_LINK' },
  { type: 'REVIEW_PAYMENT_MESSAGE' }, { type: 'SHARE_PAYMENT_LINK' }, { type: 'QUERY_PAYMENT_TIMEOUT' },
];
function timeout() { return PAYMENT_ACTIONS.reduce(reduce, closed()); }
const renderTab = (activeTab: typeof EVENT_TABS[number]['id']) => renderToStaticMarkup(<EventWorkspace activeTab={activeTab} proposalArtifact={artifact} />);

test('fixture preserves separate event, opportunity, contact, account and thread identities', () => {
  const state = createEventWorkflowState();
  assert.deepEqual(state.identity, { eventId: 'DEMO-EVT-042', opportunityId: 'DEMO-OP-042', leadId: 'DEMO-L-014', accountId: 'DEMO-GOURMET', mailbox: 'eventos@invalid.test', recipient: 'aurora@invalid.test', threadId: 'DEMO-TH-042' });
  assert.equal(new Set(Object.values(state.identity)).size, 7);
  assert.equal(state.mode, 'synthetic');
  assert.equal(EVENT_FIXTURE.brief.attendees, 24);
  assert.match(EVENT_FIXTURE.messages[0].text, /20 personas/);
  assert.match(EVENT_FIXTURE.messages[1].text, /24 personas/);
});

test('no workflow starts approved, sent, closed, paid or reserved', () => {
  const state = createEventWorkflowState();
  assert.equal(state.approval, null); assert.equal(state.simulatedHandoff, false); assert.equal(state.humanClosed, false);
  assert.equal(state.sourcingStarted, false); assert.equal(state.payment.step, 'not_prepared');
  assert.equal(state.payment.collected, null); assert.equal(state.payment.balance, null); assert.equal(state.payment.realUrl, null);
  assert.equal(state.meeting.center, null); assert.equal(state.meeting.room, null); assert.equal(state.meeting.foodPermission, 'unknown');
  assert.equal(state.meeting.cost, null); assert.equal(state.meeting.reservation, 'not_booked');
});

test('quote arithmetic uses DEMO units with taxes explicitly not modeled', () => {
  assert.equal(EVENT_FIXTURE.quote.lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0), 3000);
  assert.equal(EVENT_FIXTURE.quote.deposit, 900); assert.equal(EVENT_FIXTURE.quote.unit, 'U. DEMO');
  assert.equal(EVENT_FIXTURE.quote.taxes, 'not_modeled');
});

test('attachment manifest matches actual local PDF bytes, not an invented context digest', () => {
  const bytes = readFileSync(new URL('../../src/office/assets/demo/DEMO-EVT-042-propuesta-v2.pdf', import.meta.url));
  assert.equal(bytes.length, 12697); assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), EVENT_FIXTURE.attachment.sha256);
  assert.equal(isExpectedProposalArtifact(artifact), true);
  assert.equal(isExpectedProposalArtifact({ ...artifact, sha256: 'different' }), false);
  assert.equal(isExpectedProposalArtifact({ ...artifact, byteLength: 0 }), false);
  assert.equal(isExpectedProposalArtifact({ ...artifact, fileName: 'wrong.pdf' }), false);
});

test('approval requires artifact and all three exact attestations', () => {
  let state = createEventWorkflowState(true, artifact);
  assert.equal(reduce(state, { type: 'APPROVE_SIMULATION' }), state);
  for (const field of ['metadata', 'content'] as const) state = reduce(state, { type: 'ATTEST', field, checked: true });
  assert.equal(canApproveSimulation(state), false);
  state = reduce(state, { type: 'ATTEST', field: 'context', checked: true });
  assert.equal(canApproveSimulation(state), true);
  assert.equal(canApproveSimulation({ ...state, artifactAvailable: false }), false);
  assert.equal(canApproveSimulation({ ...state, draft: { ...state.draft, attachmentIncluded: false } }), false);
});

test('approval compares exact metadata, contents and captured context without sending', () => {
  const state = approved();
  assert.equal(hasCurrentApproval(state), true); assert.equal(state.simulatedHandoff, false); assert.equal(state.humanClosed, false);
  const capture = JSON.parse(state.approval!.snapshot);
  assert.deepEqual(capture.identity, EVENT_FIXTURE.identity);
  assert.deepEqual(capture.context.sources, EVENT_FIXTURE.sources);
  assert.deepEqual(capture.context.messages, EVENT_FIXTURE.messages);
  assert.equal(capture.attachment.sha256, EVENT_FIXTURE.attachment.sha256);
  assert.equal(capture.draft.body, EVENT_FIXTURE.body);
  assert.equal(capture.draft.cc, ''); assert.equal(capture.draft.bcc, '');
  assert.equal(state.approval!.snapshot, exactReviewSnapshot(state));
});

for (const field of ['to', 'cc', 'bcc', 'subject', 'body'] as DraftField[]) {
  test(`editing ${field} invalidates approval and dependent simulated stages`, () => {
    const previous = timeout();
    const state = reduce(previous, { type: 'EDIT_DRAFT', field, value: `${previous.draft[field]} changed` });
    assert.equal(state.approval, null); assert.equal(hasCurrentApproval(state), false);
    assert.deepEqual(state.attestations, { metadata: false, content: false, context: false });
    assert.equal(state.simulatedHandoff, false); assert.equal(state.humanClosed, false); assert.equal(state.payment.step, 'not_prepared');
    assert.equal(state.draft.revision, previous.draft.revision + 1); assert.deepEqual(state.identity, previous.identity);
    assert.match(state.notice, /Revisión invalidada/);
  });
}

test('same-value edit is idempotent and does not invalidate the reviewed version', () => {
  const state = approved(); assert.equal(reduce(state, { type: 'EDIT_DRAFT', field: 'subject', value: state.draft.subject }), state);
});

test('attachment removal, availability loss and context change invalidate review', () => {
  for (const action of [{ type: 'SET_ATTACHMENT', included: false }, { type: 'ARTIFACT_AVAILABLE', available: false }, { type: 'CONTEXT_CHANGED' }] as EventWorkflowAction[]) {
    const state = reduce(approved(), action); assert.equal(state.approval, null); assert.equal(canApproveSimulation(state), false);
  }
  const state = reduce(approved(), { type: 'CONTEXT_CHANGED' }); assert.equal(state.contextRevision, 3);
  assert.equal(state.identity.eventId, 'DEMO-EVT-042');
});

test('withdrawing an attestation removes approval, and blank essential fields cannot be approved', () => {
  assert.equal(reduce(approved(), { type: 'ATTEST', field: 'metadata', checked: false }).approval, null);
  for (const field of ['to', 'subject', 'body'] as const) {
    const state = attested(); assert.equal(canApproveSimulation({ ...state, draft: { ...state.draft, [field]: '   ' } }), false);
  }
});

test('exact approval cannot follow a swapped account, mailbox, event or thread', () => {
  const state = approved();
  for (const field of ['accountId', 'mailbox', 'eventId', 'threadId'] as const) {
    const swapped = { ...state, identity: { ...state.identity, [field]: 'OTHER' } } as EventWorkflowState;
    assert.equal(hasCurrentApproval(swapped), false);
    assert.equal(reduce(swapped, { type: 'HANDOFF_SIMULATION' }), swapped);
  }
});

test('handoff and human close are explicit and cannot be skipped', () => {
  const initial = createEventWorkflowState(true, artifact);
  for (const type of ['HANDOFF_SIMULATION', 'CLOSE_SALE_SIMULATION', 'START_SOURCING_SIMULATION', 'PREPARE_PAYMENT'] as const) assert.equal(reduce(initial, { type }), initial);
  const state = approved(); assert.equal(reduce(state, { type: 'CLOSE_SALE_SIMULATION' }), state);
  const sent = reduce(state, { type: 'HANDOFF_SIMULATION' }); assert.equal(sent.simulatedHandoff, true); assert.equal(sent.humanClosed, false);
  const complete = reduce(sent, { type: 'CLOSE_SALE_SIMULATION' }); assert.equal(complete.humanClosed, true);
  assert.equal(complete.sourcingStarted, false); assert.equal(complete.payment.step, 'not_prepared');
});

test('closing only enables sourcing; starting search never supplies contact or availability evidence', () => {
  const state = reduce(closed(), { type: 'START_SOURCING_SIMULATION' });
  assert.equal(state.sourcingStarted, true); assert.match(state.notice, /sin contacto, disponibilidad, aceptación ni asignación/);
  assert.equal(state.meeting.reservation, 'not_booked'); assert.equal(state.payment.collected, null);
});

test('repeated approval, handoff, close and sourcing clicks are idempotent', () => {
  let state = attested();
  for (const type of ['APPROVE_SIMULATION', 'HANDOFF_SIMULATION', 'CLOSE_SALE_SIMULATION', 'START_SOURCING_SIMULATION'] as const) {
    state = reduce(state, { type }); assert.equal(reduce(state, { type }), state);
  }
});

test('payment request, generation, review, sharing and verification are distinct gated steps', () => {
  let state = closed();
  for (const action of PAYMENT_ACTIONS.slice(1)) assert.equal(reduce(state, action), state);
  for (const action of PAYMENT_ACTIONS) {
    const previousStep = state.payment.step;
    state = reduce(state, action); assert.notEqual(state.payment.step, previousStep);
    assert.equal(reduce(state, action), state);
    assert.equal(state.payment.realUrl, null); assert.equal(state.payment.collected, null); assert.equal(state.payment.balance, null);
    assert.equal(state.identity.accountId, 'DEMO-GOURMET'); assert.equal(state.payment.requestId, 'PR-042:r2');
  }
  assert.equal(state.payment.step, 'unknown'); assert.equal(state.payment.attempts, 1); assert.equal(state.payment.linkId, 'LINK-LAB-042');
  assert.match(state.notice, /TIMEOUT_DEMO/);
});

test('a timeout never becomes zero, new request, resend or automatic retry', () => {
  const state = timeout();
  assert.deepEqual(paymentScenarioView(state), { scenario: 'unknown', label: 'Escenario principal: cobro desconocido', collected: null, balance: null, reconciliation: 'pending', supplierException: false });
  for (const action of PAYMENT_ACTIONS) assert.equal(reduce(state, action), state);
  assert.equal(state.payment.attempts, 1);
});

test('confirmed 900 is a separate scenario with 2100 balance and exception, preserving principal', () => {
  const state = timeout(); const paymentBefore = state.payment;
  const alternative = reduce(state, { type: 'SELECT_PAYMENT_SCENARIO', scenario: 'confirmed_900' });
  const view = paymentScenarioView(alternative);
  assert.equal(view.collected, 900); assert.equal(view.balance, 2100); assert.equal(view.reconciliation, 'pending'); assert.equal(view.supplierException, true);
  assert.equal(alternative.payment, paymentBefore); assert.equal(alternative.payment.collected, null); assert.equal(alternative.payment.balance, null);
  const returned = reduce(alternative, { type: 'SELECT_PAYMENT_SCENARIO', scenario: 'unknown' });
  assert.equal(returned.payment, paymentBefore); assert.equal(paymentScenarioView(returned).collected, null);
});

test('meeting preparation requires city and zone and cannot reserve or assume permission/cost', () => {
  let state = createEventWorkflowState(); assert.equal(reduce(state, { type: 'PREPARE_MEETING' }), state);
  state = reduce(state, { type: 'EDIT_MEETING', field: 'zone', value: 'Zona de prueba' });
  state = reduce(state, { type: 'PREPARE_MEETING' }); assert.equal(state.meeting.prepared, true);
  assert.equal(reduce(state, { type: 'PREPARE_MEETING' }), state);
  assert.equal(state.meeting.reservation, 'not_booked'); assert.equal(state.meeting.cost, null); assert.equal(state.meeting.foodPermission, 'unknown');
  assert.equal(state.meeting.center, null); assert.equal(state.meeting.room, null);
  state = reduce(state, { type: 'EDIT_MEETING', field: 'city', value: 'Otra ciudad' }); assert.equal(state.meeting.prepared, false);
  assert.equal(EVENT_FIXTURE.brief.city, 'Lima'); assert.equal(EVENT_FIXTURE.brief.dateStatus, 'proposed_unreserved');
});

test('planning checkboxes only alter local notes, not payment or event readiness', () => {
  let state = createEventWorkflowState();
  for (const task of ['menu', 'transport', 'purchases'] as const) { state = reduce(state, { type: 'SET_PLANNING', task, checked: true }); assert.equal(reduce(state, { type: 'SET_PLANNING', task, checked: true }), state); }
  assert.equal(state.humanClosed, false); assert.equal(state.payment.collected, null); assert.equal(state.meeting.reservation, 'not_booked');
  assert.match(state.notice, /No acredita/);
});

test('reset clears all transient progress but preserves expected synthetic identity and availability', () => {
  const state = reduce(timeout(), { type: 'RESET' }); assert.deepEqual(state, createEventWorkflowState(true, artifact));
  assert.equal(reduce(state, { type: 'RESET', artifactAvailable: false }).artifactAvailable, false);
});

test('workspace renders seven real accessible tabs and one selected panel', () => {
  const html = renderTab('consulta');
  assert.equal((html.match(/role="tab"/g) ?? []).length, 7); assert.equal((html.match(/role="tabpanel"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  assert.match(html, /role="tablist" aria-label="Etapas del mismo evento"/); assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /DEMO-GOURMET/); assert.match(html, /eventos@invalid.test/); assert.match(html, /aurora@invalid.test/); assert.match(html, /DEMO-TH-042/);
  assert.match(html, /20 personas/); assert.match(html, /24 personas/); assert.match(html, /sin cuentas conectadas/);
});

test('controlled activeTab takes precedence and visible false renders no duplicate workspace', () => {
  const html = renderToStaticMarkup(<EventWorkspace initialTab="consulta" activeTab="tastings" proposalArtifact={artifact} />);
  assert.match(html, /Coordinar en Regus/); assert.doesNotMatch(html, /class="gew-messages"/);
  assert.equal(renderToStaticMarkup(<EventWorkspace visible={false} />), '');
});

test('quote offers version history and laboratory total without claiming commercial validity', () => {
  const html = renderTab('cotizacion'); assert.match(html, /v1 · obsoleta/); assert.match(html, /v2 · vigente/);
  assert.match(html, /<caption>Precios de laboratorio/); assert.match(html, /Impuestos no modelados/); assert.match(html, /no moneda/);
  assert.match(html, /Revisar mensaje y adjunto/); assert.match(html, /Saldo/); assert.match(html, /Desconocido hasta verificar cobros/);
});

test('exact review exposes original context, full editable message and strictly local PDF', () => {
  const html = renderTab('revision'); assert.match(html, /DEMO-MSG-01/); assert.match(html, /DEMO-MSG-02/);
  assert.match(html, /<textarea/); assert.match(html, /Hola, Aurora:/); assert.match(html, /Texto completo que se revisaría/);
  for (const source of EVENT_FIXTURE.sources) assert.ok(html.includes(source));
  assert.match(html, /href="\/office\/assets\/DEMO-EVT-042-propuesta-v2.pdf"/);
  assert.match(html, /SHA-256 calculado sobre el PDF local/); assert.match(html, /sin atribuirle una huella de archivo/);
  assert.match(html, /href="\/office\/communications"/); assert.match(html, /no se transfiere ni crea otra cola real/);
  assert.match(html, /disabled="">Simular aprobación exacta/); assert.match(html, /disabled="">Enviar correo real/);
});

test('missing, remote or malicious artifact URL never becomes an external PDF link', () => {
  for (const proposalArtifact of [undefined, { ...artifact, href: 'https://third-party.example/file.pdf' }, { ...artifact, href: '//third-party.example/file.pdf' }, { ...artifact, href: 'javascript:alert(1)' }, { ...artifact, href: '/\\third-party.example/file.pdf' }]) {
    const html = renderToStaticMarkup(<EventWorkspace activeTab="revision" proposalArtifact={proposalArtifact} />);
    assert.match(html, /PDF local no disponible/); assert.doesNotMatch(html, /Descargar PDF completo<\/a>/);
  }
});

test('payment and operation rendering preserve unknowns and meaningful disabled real actions', () => {
  const html = renderTab('cobro'); assert.match(html, /event-collected">Desconocido/); assert.match(html, /event-balance">Desconocido/);
  assert.match(html, /Principal · desconocido/); assert.match(html, /Alternativo · 900 confirmados/); assert.match(html, /URL real/); assert.match(html, /No generada/);
  assert.doesNotMatch(html, /href="https?:|href="[^\"]*checkout|payment\.example/); // This UI never links a payment service.
  const operations = renderTab('operaciones'); assert.match(operations, /Disponibilidad desconocida/); assert.match(operations, /No aceptado/); assert.match(operations, /No asignado/);
  assert.match(operations, /disabled="">Contactar proveedor real/); assert.match(operations, /Preparación incompleta/);
});

test('Regus coordination renders unknown room, cost and food permission with disabled bookings', () => {
  const html = renderTab('tastings'); assert.match(html, /Regus/); assert.match(html, /Ciudad propuesta/); assert.match(html, /Zona propuesta/);
  assert.match(html, /Permiso desconocido/); assert.match(html, /Desconocido; no es cero/); assert.match(html, /No realizada/);
  assert.match(html, /disabled="">Reservar sala real/); assert.match(html, /disabled="">Enviar invitación real/);
});

test('workflow has no network, connector, storage or real-data imports and styles remain scoped', () => {
  for (const file of ['../../src/office/dashboard/event-workflow.ts', '../../src/office/dashboard/EventWorkspace.tsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB)\b/);
    assert.doesNotMatch(source, /from ['"][^'"]*(backend|realdata|communications-api|dashboard\/source)/);
  }
  const css = readFileSync(new URL('../../src/office/dashboard/event-workflow.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /Georgia|#f4f3ed|#fffef9|:root/); assert.match(css, /\.gourmet-event-workspace/);
});


test('preview metadata matches rendered local PNG bytes and missing metadata blocks approval', () => {
  const bytes = readFileSync(new URL('../../src/office/assets/demo/DEMO-EVT-042-propuesta-v2-page-1.png', import.meta.url));
  assert.equal(bytes.length, EVENT_FIXTURE.preview.byteLength);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), EVENT_FIXTURE.preview.sha256);
  assert.equal(isExpectedPreviewArtifact(artifact), true);
  assert.equal(isExpectedPreviewArtifact({ ...artifact, previewHref: undefined }), false);
  assert.equal(isExpectedPreviewArtifact({ ...artifact, previewSha256: undefined }), false);
  assert.equal(isExpectedPreviewArtifact({ ...artifact, previewByteLength: 0 }), false);
  assert.equal(createEventWorkflowState(true).artifactAvailable, false);
});

test('same-valid-metadata PDF href swap invalidates exact approval and all attestations', () => {
  const previous = approved();
  const changed = { ...artifact, href: '/office/assets/other-local-file.pdf' };
  assert.equal(isExpectedPreviewArtifact(changed), true);
  const state = reduce(previous, { type: 'SYNC_ARTIFACT', artifact: changed });
  assert.notEqual(exactReviewSnapshot(state), exactReviewSnapshot(previous));
  assert.equal(state.approval, null); assert.equal(hasCurrentApproval(state), false);
  assert.deepEqual(state.attestations, { metadata: false, content: false, context: false });
  assert.equal(state.artifact!.href, changed.href);
  assert.deepEqual(state.identity, previous.identity);
});

test('preview href and metadata are included in the exact artifact identity', () => {
  const previous = approved();
  const capture = JSON.parse(previous.approval!.snapshot);
  assert.deepEqual(capture.artifact, normalizeProposalArtifact(artifact));
  for (const changed of [
    { ...artifact, previewHref: '/office/assets/other-local-preview.png' },
    { ...artifact, previewSha256: 'different' },
    { ...artifact, previewByteLength: 0 },
  ]) {
    const state = reduce(previous, { type: 'SYNC_ARTIFACT', artifact: changed });
    assert.equal(state.approval, null); assert.equal(hasCurrentApproval(state), false);
    assert.notEqual(proposalArtifactIdentity(state.artifact), proposalArtifactIdentity(previous.artifact));
  }
});

test('normalization preserves unchanged artifact approval across navigation and object recreation', () => {
  const previous = approved();
  assert.equal(reduce(previous, { type: 'SYNC_ARTIFACT', artifact: { ...artifact } }), previous);
  assert.equal(reduce(previous, { type: 'SYNC_ARTIFACT', artifact: { ...artifact, href: '/office/assets/temporary/../DEMO-EVT-042-propuesta-v2.pdf' } }), previous);
});

test('runtime image failure invalidates review and stale failures cannot affect a new artifact', () => {
  const previous = approved();
  const failed = reduce(previous, { type: 'ARTIFACT_AVAILABLE', available: false, artifactIdentity: proposalArtifactIdentity(artifact) });
  assert.equal(failed.artifactAvailable, false); assert.equal(failed.approval, null); assert.equal(canApproveSimulation(failed), false);
  assert.equal(reduce(failed, { type: 'SYNC_ARTIFACT', artifact: { ...artifact } }), failed);
  const replaced = reduce(previous, { type: 'SYNC_ARTIFACT', artifact: { ...artifact, previewHref: '/office/assets/replacement.png' } });
  assert.equal(reduce(replaced, { type: 'ARTIFACT_AVAILABLE', available: false, artifactIdentity: proposalArtifactIdentity(artifact) }), replaced);
});

test('PDF inspection is in-page and downloads do not open a new tab', () => {
  const html = renderTab('revision');
  assert.match(html, /Ver vista previa del PDF/);
  assert.match(html, /aria-expanded="false" aria-controls=/);
  assert.match(html, /download="DEMO-EVT-042-propuesta-v2.pdf">Descargar PDF completo/);
  assert.doesNotMatch(html, /target="_blank"|<iframe|<object|<embed/);
  assert.match(html, /Leer el texto extraído del PDF/);
  assert.match(html, /No es una cotización comercial de Gourmet/);
  assert.match(html, /Resto esperado: 2.100 U. DEMO solo si se verifica el anticipo/);
  assert.match(PROPOSAL_PDF_EXTRACTED_TEXT, /La versión v1 para 20 personas queda superada/);
  const source = readFileSync(new URL('../../src/office/dashboard/EventWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="event-pdf-preview"/);
  assert.match(source, /onError=\{\(\) => dispatch/);
  assert.doesNotMatch(source, /window\.open|target="_blank"/);
});

test('missing or invalid preview stays explicit rather than presenting content as reviewable', () => {
  for (const missing of [{ ...artifact, previewHref: undefined }, { ...artifact, previewHref: 'https://example.test/preview.png' }, { ...artifact, previewSha256: 'wrong' }]) {
    const html = renderToStaticMarkup(<EventWorkspace activeTab="revision" proposalArtifact={missing} />);
    assert.match(html, /Vista previa local no disponible o no cargada correctamente/);
    assert.match(html, /No se puede aprobar esta simulación mientras falte/);
    assert.doesNotMatch(html, /Ver vista previa del PDF<\/button>/);
    assert.match(html, /disabled="">Simular aprobación exacta/);
  }
});


test('draft body has an explicit stable accessible label independent of its content', () => {
  const html = renderTab('revision');
  const label = html.match(/<label for="([^"]+)">Texto completo que se revisaría<\/label>/);
  assert.ok(label, 'body label must contain only its label text');
  assert.ok(html.includes(`<textarea id="${label[1]}" rows="10">`));
  assert.doesNotMatch(html, /<label[^>]*>Texto completo que se revisaría<textarea/);
});
