import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardInbox, DashboardKanban, DashboardPage, DashboardReadGate, DashboardReviewPanel, DashboardSources, sectionFromHash } from '../../src/office/DashboardPage';
import { dashboardFixtureSource } from '../../src/office/dashboard/source';
import type { ApprovalQueue } from '../../src/office/dashboard/contracts';

const fixture = () => dashboardFixtureSource.read(new AbortController().signal);
const render = renderToStaticMarkup;
const noop = () => {};

test('dashboard starts with an honest local loading state and no queue read or implicit session', () => {
  const html = render(<DashboardPage />);
  assert.match(html, /Preparando tu vista/);
  assert.match(html, /Datos sintéticos/);
  assert.match(html, /sin conexión a proveedores/);
  assert.match(html, /Sin consulta vigente/);
  assert.doesNotMatch(html, /data-testid="dashboard-read-reviews"/);
  assert.doesNotMatch(html, /<form|localStorage|<img|<iframe/);
});

test('approved overview separates source sample count from unknown financials and opt-in design data', async () => {
  const snapshot = await fixture();
  const html = render(<DashboardPage initialSnapshot={snapshot} />);
  assert.match(html, /<h1[^>]*>Dashboard<\/h1>/);
  assert.equal((html.match(/data-testid="approved-metric-/g) ?? []).length, 3);
  assert.match(html, /data-testid="approved-metric-opportunities"/);
  assert.match(html, /Oportunidades de muestra/);
  assert.match(html, /<p class="ga-metric-value">4<\/p>/);
  assert.equal((html.match(/<p class="ga-metric-value">—<\/p>/g) ?? []).length, 2);
  assert.match(html, /Ingresos reservados sin verificar/);
  assert.match(html, /Sin cuenta ni atribución verificadas/);
  assert.match(html, /Corte:/); assert.match(html, /Cobertura:/); assert.match(html, /UTC/);
  assert.match(html, /datos reales desconocidos/);
  assert.doesNotMatch(html, /data-testid="dashboard-read-reviews"/);
  assert.match(html, /href="\/office\/"/);
  assert.match(html, /href="\/office\/communications"/);
  assert.doesNotMatch(html, /18\.400|68%|LIVE|En vivo|Agente activo|<canvas/);
  const demo = render(<DashboardPage initialSnapshot={snapshot} initialVisualDemo />);
  assert.match(demo, /18\.400/); assert.match(demo, /Cifras ficticias en unidades DEMO/);
  assert.doesNotMatch(demo, /data-testid="dashboard-read-reviews"/);
});

test('unimplemented catalog remains disabled while proposals and payment simulation are discoverable', async () => {
  const html = render(<DashboardPage initialSnapshot={await fixture()} />);
  assert.match(html, /disabled="" title="Catálogo: pendiente de implementación"/);
  assert.match(html, /<span>Propuestas<\/span>/);
  assert.match(html, /<span>Enlaces de pago<\/span>/);
  const quote = render(<DashboardPage initialSnapshot={await fixture()} initialSection="quotes" />);
  assert.match(quote, /Cotización · QUOTE-042/); assert.match(quote, /v1 · obsoleta/);
  const payment = render(<DashboardPage initialSnapshot={await fixture()} initialSection="payments" />);
  assert.match(payment, /URL real<\/dt><dd>No generada/);
  assert.doesNotMatch(payment, /href="https:/);
});

test('Kanban contains four semantic columns, safe sample cards, counts, missing amounts and stage ages', async () => {
  const html = render(<DashboardKanban snapshot={await fixture()} />);
  assert.equal((html.match(/<section /g) ?? []).length, 4);
  assert.equal((html.match(/data-testid="dashboard-opportunity"/g) ?? []).length, 4);
  assert.match(html, /Nueva consulta/); assert.match(html, /Por definir/); assert.match(html, /Propuesta/); assert.match(html, /Confirmado/);
  assert.equal((html.match(/Importe sin verificar/g) ?? []).length, 4);
  assert.match(html, /Sin fecha verificada/);
  assert.match(html, /días en etapa/);
  assert.doesNotMatch(html, /draggable|onDrag|<button|<input|<select|<form/);
});

test('inbox keeps distinct conversations and distinguishes unconfigured real sources from sample content', async () => {
  const html = render(<DashboardInbox snapshot={await fixture()} />);
  assert.equal((html.match(/class="gd-conversation[ "]/g) ?? []).length, 3);
  assert.match(html, /La misma consulta en otro buzón/);
  assert.match(html, /Correo sin configurar como fuente real/);
  assert.match(html, /Los mensajes de ejemplo no acreditan una conexión/);
  assert.match(html, /Seleccionar no marca como leído/);
  assert.match(html, /info@example.test/);
  assert.match(html, /Sin vinculación verificada/);
  assert.match(html, /class="gd-button gd-button-dark gd-review-cta" href="\/office\/communications"/);
  assert.match(html, /Revisar en Comunicaciones/);
  assert.match(html, /no vincula automáticamente/);
  for (const channel of ['Correo', 'Formulario web', 'Instagram', 'Messenger']) assert.match(html, new RegExp(channel));
  assert.doesNotMatch(html, /<textarea|<form|>Enviar<|>Aprobar<|>Eliminar</);
});

test('empty inbox never claims that an unconfigured real mailbox is empty', async () => {
  const snapshot = await fixture(); snapshot.conversations = [];
  const html = render(<DashboardInbox snapshot={snapshot} />);
  assert.match(html, /Correo pendiente de conexión/);
  assert.match(html, /La bandeja real no se ha consultado/);
  assert.doesNotMatch(html, /Bandeja vacía|Sin mensajes nuevos/);
  snapshot.sources.find(source => source.id === 'gmail')!.mode = 'fixture';
  const configured = render(<DashboardInbox snapshot={snapshot} />);
  assert.match(configured, /Sin conversaciones en la muestra/);
  assert.match(configured, /No indica que tu bandeja real esté vacía/);
});

test('sources expose fixed provenance, absent connections and unknown coverage', async () => {
  const html = render(<DashboardSources snapshot={await fixture()} />);
  assert.match(html, /Muestra local/);
  assert.match(html, /Sin configurar/);
  assert.match(html, /Sin verificación/);
  assert.match(html, /Desconocida/);
  assert.match(html, /Corte fijo de la muestra/);
  assert.doesNotMatch(html, /<button|<form/);
});

test('external-looking text is escaped across inbox, opportunity and source cards', async () => {
  const hostile = '<img src="https://tracking.invalid/pixel"><script>alert(1)</script>';
  const snapshot = await fixture();
  Object.assign(snapshot.conversations[0], { contact: hostile, subject: hostile, bodyText: hostile, mailbox: hostile });
  Object.assign(snapshot.opportunities[0], { name: hostile, event: hostile });
  Object.assign(snapshot.sources[0], { label: hostile, note: hostile });
  for (const element of [<DashboardInbox snapshot={snapshot} />, <DashboardKanban snapshot={snapshot} />, <DashboardSources snapshot={snapshot} />]) {
    const html = render(element); assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<img|<script|<iframe/);
  }
});

test('review panel starts unknown, fails closed, and displays exact mailbox/revision with generic safe links', () => {
  const plain = { busy: false, error: null, notice: null, onRead: noop };
  const unknown = render(<DashboardReviewPanel {...plain} queue={null} />);
  assert.match(unknown, /Aún no consultada/); assert.doesNotMatch(unknown, /Sin pendientes/);
  const failed = render(<DashboardReviewPanel {...plain} queue={null} error="No se pudo verificar esta lectura." />);
  assert.match(failed, /role="alert"/); assert.doesNotMatch(failed, /Sin pendientes/);
  const queue: ApprovalQueue = { mode: 'fixture', workflowRevision: 12, expiresAt: '2099-10-13T15:00:00.000Z', outboundEffects: 0, items: [{ id: 'test-draft', revision: 4, digest: 'secret-should-not-be-shown', subject: '<script>no</script>', recipient: 'example@example.test', mailbox: 'info@example.test', state: 'approved_unsent', reason: 'No se ha enviado ningún mensaje.', href: '/office/communications' }] };
  const html = render(<DashboardReviewPanel {...plain} queue={queue} />);
  assert.match(html, /Revisión del borrador: 4/); assert.match(html, /info@example.test/); assert.match(html, /example@example.test/);
  assert.match(html, /Aprobado en la muestra · no enviado/); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="\/office\/communications"/); assert.doesNotMatch(html, /href="[^\"]*\?/);
  assert.match(html, /Este enlace no conserva una selección ni una aprobación/);
  assert.doesNotMatch(html, /secret-should-not-be-shown|<script|>Aprobar<|>Enviar</);
  const failedWithStaleQueue = render(<DashboardReviewPanel {...plain} queue={queue} error="La lectura falló." />);
  assert.doesNotMatch(failedWithStaleQueue, /example@example.test|info@example.test|Revisión del borrador/);
  queue.items = [];
  assert.match(render(<DashboardReviewPanel {...plain} queue={queue} />), /Sin pendientes en esta cola sintética consultada/);
});

test('read gate rejects late responses after a newer read or withdrawal even if abort is ignored', () => {
  const gate = new DashboardReadGate();
  const first = gate.start(); assert.equal(first.current(), true);
  const second = gate.start(); assert.equal(first.signal.aborted, true); assert.equal(first.current(), false); assert.equal(second.current(), true);
  gate.cancel(); assert.equal(second.signal.aborted, true); assert.equal(second.current(), false);
  const third = gate.start(); assert.equal(third.current(), true); assert.equal(first.current(), false);
  gate.cancel(); gate.cancel(); assert.equal(third.current(), false);
});

test('dashboard implementation has no storage, command, provider or approval capability', () => {
  const source = readFileSync(new URL('../../src/office/DashboardPage.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /localStorage|sessionStorage|dangerouslySetInnerHTML|fetch\(|startSession\(|\.approve\(|\.dispatch\(|\.send\(|bodyHtml/);
  assert.match(source, /visibilitychange/); assert.match(source, /pagehide/); assert.match(source, /15 \* 60 \* 1000/);
  const css = readFileSync(new URL('../../src/office/dashboard.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /(^|})\s*(body|:root|button|h1|a|\*)\s*\{/m);
});


test('all initial section previews retain the shell, provenance and correct active navigation', async () => {
  const snapshot = await fixture();
  for (const [section, heading, navigation] of [
    ['summary', 'Dashboard', 'Dashboard'],
    ['opportunities', 'Oportunidades', 'Oportunidades'],
    ['inbox', 'Bandeja', 'Bandeja'],
    ['sources', 'Fuentes', 'Fuentes'],
    ['reviews', 'Revisión local', 'Revisión local'],
  ] as const) {
    const html = render(<DashboardPage initialSnapshot={snapshot} initialSection={section} />);
    assert.match(html, new RegExp(`<h1[^>]*>${heading}</h1>`));
    assert.match(html, /data-testid="dashboard-provenance"/);
    assert.match(html, /0 envíos · sin conexión a proveedores/);
    assert.match(html, /aria-current="page"/);
    assert.match(html, new RegExp(navigation));
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    assert.equal(html.includes('data-testid="dashboard-read-reviews"'), section === 'reviews');
  }
});


test('approved shell navigation focuses new headings and route parsing only accepts local known sections', () => {
  const source = readFileSync(new URL('../../src/office/DashboardPage.tsx', import.meta.url), 'utf8');
  const shell = readFileSync(new URL('../../src/office/dashboard/ApprovedDashboardLayout.tsx', import.meta.url), 'utf8');
  assert.match(shell, /headingRef.current\?\.focus\(\)/);
  assert.match(shell, /<h1 ref=\{headingRef\} tabIndex=\{-1\}/);
  assert.match(source, /popstate/); assert.match(source, /hashchange/);
  assert.match(source, /visible=\{eventTab !== undefined\}/);
  assert.equal(sectionFromHash('#quotes/revision'), 'quotes');
  assert.equal(sectionFromHash('#events/brief'), 'events');
  assert.equal(sectionFromHash('#payments'), 'payments');
  assert.equal(sectionFromHash(''), 'summary');
  assert.equal(sectionFromHash('#javascript:alert(1)'), null);
  assert.equal(sectionFromHash('#https://external.invalid'), null);
  assert.equal(sectionFromHash('#unknown'), null);
});

test('unconfigured empty channel badges show unknown instead of a real inbox zero', async () => {
  const html = render(<DashboardInbox snapshot={await fixture()} />);
  assert.match(html, /<span>Instagram<\/span><span class="gd-filter-count" aria-label="Sin datos del canal">—<\/span>/);
  assert.match(html, /<span>Messenger<\/span><span class="gd-filter-count" aria-label="Sin datos del canal">—<\/span>/);
  assert.match(html, /aria-label="Conversaciones de ejemplo">3<\/span>/);
});
