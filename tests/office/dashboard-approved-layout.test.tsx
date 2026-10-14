import React from 'react';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { APPROVED_VISUAL_DEMO, ApprovedDashboardSummary, DashboardShell, type Section } from '../../src/office/dashboard/ApprovedDashboardLayout';

const noop = () => {};
const shell = (children: React.ReactNode, props: Partial<React.ComponentProps<typeof DashboardShell>> = {}) => render(<DashboardShell section="summary" onNavigate={noop} {...props}>{children}</DashboardShell>);

test('approved summary defaults to unknown actual data and never silently adopts fictional values', () => {
  const html = render(<ApprovedDashboardSummary />);
  assert.match(html, /data-visual-demo="false"/);
  assert.match(html, /Datos reales desconocidos/);
  assert.match(html, /Sin cuentas conectadas/);
  assert.match(html, /Muestra local sin consultar/);
  assert.match(html, /Ingresos reservados sin verificar/);
  assert.match(html, /Borradores reales/);
  assert.match(html, /La cola real no se ha consultado/);
  assert.equal((html.match(/data-testid="approved-metric-/g) ?? []).length, 3);
  assert.equal((html.match(/data-testid="approved-ad-cell"/g) ?? []).length, 4);
  assert.equal((html.match(/data-testid="approved-revenue-bar"/g) ?? []).length, 0);
  assert.doesNotMatch(html, /18\.400|1\.120|68%|hace 2 min|Aurora|borradores esperando|>0<|>4</);
});

test('only the explicit visual demo reproduces three KPI values, four ad cells, six bars and two activity rows', () => {
  const html = render(<ApprovedDashboardSummary visualDemo />);
  assert.match(html, /data-visual-demo="true"/);
  assert.match(html, /Cifras ficticias en unidades DEMO/);
  assert.match(html, /Sin cuentas conectadas/);
  assert.match(html, /no representan ingresos cobrados/);
  assert.equal((html.match(/data-testid="approved-metric-/g) ?? []).length, 3);
  assert.equal((html.match(/data-testid="approved-ad-cell"/g) ?? []).length, 4);
  assert.equal((html.match(/data-testid="approved-revenue-bar"/g) ?? []).length, 6);
  for (const metric of APPROVED_VISUAL_DEMO.metrics) assert.ok(html.includes(metric.value));
  for (const ad of APPROVED_VISUAL_DEMO.ads) assert.ok(html.includes(ad.value));
  for (const month of APPROVED_VISUAL_DEMO.months) assert.ok(html.includes(month.value));
  assert.equal((html.match(/class="ga-activity-time"/g) ?? []).length, 2);
  assert.match(html, /12 meses<span class="ga-visually-hidden">, no disponible/);
  assert.doesNotMatch(html, /<button|<form|<iframe|<canvas/);
});

test('local source opportunity counts remain separate from candidate contacts and unknown finances', () => {
  for (const count of [0, 4, 20]) {
    const html = render(<ApprovedDashboardSummary sampleOpportunityCount={count} />);
    assert.match(html, /data-testid="approved-metric-opportunities"/);
    assert.ok(html.includes(`<p class="ga-metric-value">${count}</p>`));
    assert.match(html, /Registros de la muestra local sintética/);
    assert.equal((html.match(/<p class="ga-metric-value">—<\/p>/g) ?? []).length, 2);
    assert.doesNotMatch(html, /Nuevos contactos este mes|18\.400|68%/);
  }
  for (const invalid of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const html = render(<ApprovedDashboardSummary sampleOpportunityCount={invalid} />);
    assert.match(html, /Muestra local sin consultar/);
    assert.equal((html.match(/<p class="ga-metric-value">—<\/p>/g) ?? []).length, 3);
  }
  const demo = render(<ApprovedDashboardSummary visualDemo sampleOpportunityCount={98765} />);
  assert.match(demo, /Nuevos contactos este mes/); assert.doesNotMatch(demo, /98765/);
});

test('shell retains the approved Gourmet groups while unavailable destinations cannot navigate', () => {
  const html = shell(<p>Panel</p>);
  for (const group of ['VISTA GENERAL', 'EVENTOS', 'FINANZAS', 'PERSONAS', 'SISTEMA']) assert.ok(html.includes(group));
  assert.match(html, /class="ga-nav-item" disabled="" title="Calendario: pendiente de implementación"/);
  assert.match(html, /class="ga-nav-item" disabled="" title="Tastings: pendiente de implementación"/);
  assert.match(html, /href="\/office\/"/);
  assert.match(html, /class="ga-skip gd-skip" href="#gd-main"/);
  assert.match(html, /<main class="ga-main" id="gd-main" tabindex="-1">/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-open="false"/);
  assert.match(html, /VISTA LOCAL/);
  assert.doesNotMatch(html, /href="#"|>Propuestas<|>Revisión local<|>Fuentes<|18\.400/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
});

test('enabled quotes, payment links, review, sources and communication destinations are explicitly discoverable', () => {
  const enabledSections: Section[] = ['summary', 'opportunities', 'quotes', 'payments', 'inbox', 'reviews', 'sources', 'communications'];
  const html = shell(<ApprovedDashboardSummary />, { section: 'quotes', enabledSections });
  assert.match(html, /aria-current="page"><span>Propuestas<\/span>/);
  assert.match(html, />Enlaces de pago<\/span>/);
  assert.match(html, />Revisión local<\/button>/);
  assert.match(html, />Fuentes<\/button>/);
  assert.match(html, /href="\/office\/communications">Comunicaciones<\/a>/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  for (const section of ['reviews', 'sources'] as const) {
    const variant = shell(<p>Content</p>, { section, enabledSections });
    assert.equal((variant.match(/aria-current="page"/g) ?? []).length, 1);
  }
});

test('brand, heading, status and action slots are reusable and arbitrary text is escaped', () => {
  const hostile = '<img src="https://tracking.invalid/pixel"><script>alert(1)</script>';
  const html = shell(<p>{hostile}</p>, { brandName: 'Otro cliente', title: hostile, subtitle: 'Vista del cliente', mainId: 'another-main', status: <p role="status">Sin consulta vigente</p>, actions: <button type="button">Actualizar</button>, visualDemo: true });
  assert.match(html, /OTRO CLIENTE/); assert.match(html, />Otro cliente<\/strong>/);
  assert.match(html, /href="#another-main"/); assert.match(html, /id="another-main"/);
  assert.match(html, /Sin consulta vigente/); assert.match(html, />Actualizar<\/button>/);
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<img|<script|<iframe|GOURMET/);
});

test('badges require an explicit valid count and never imply a connected inbox', () => {
  assert.doesNotMatch(shell(<p />), /ga-inbox-badge/);
  for (const count of [NaN, Infinity, -1, 0, 0.5, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.doesNotMatch(shell(<p />, { inboxBadgeCount: count }), /ga-inbox-badge/);
  const demo = shell(<p />, { inboxBadgeCount: 4, visualDemo: true, enabledSections: ['inbox'] });
  assert.match(demo, /4 elementos de demostración/);
  const local = shell(<p />, { inboxBadgeCount: 3, enabledSections: ['inbox'] });
  assert.match(local, /3 elementos en la vista local/);
  assert.doesNotMatch(local, /conectada|en vivo|live/i);
});

test('assistant navigation is opt-in and never exposes approval or dispatch capability', () => {
  const noAction = render(<ApprovedDashboardSummary visualDemo />);
  const action = render(<ApprovedDashboardSummary visualDemo onOpenInbox={noop} />);
  assert.doesNotMatch(noAction, /<button/);
  assert.match(action, /class="ga-agent-note ga-inline-action" type="button"/);
  assert.doesNotMatch(action, />Enviar<|>Aprobar<|<form|\/office-api\//);
  const code = readFileSync(new URL('../../src/office/dashboard/ApprovedDashboardLayout.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /localStorage|sessionStorage|dangerouslySetInnerHTML|fetch\(|startSession\(|\.approve\(|\.dispatch\(|\.send\(/);
  assert.match(code, /headingRef.current\?\.focus\(\)/);
  assert.match(code, /setMenuOpen\(false\)/);
  assert.match(code, /if \(!available.has\(next\)\) return/);
});

test('approved CSS is shell-scoped, themeable, responsive and provides focus and touch-target rules', () => {
  const css = readFileSync(new URL('../../src/office/dashboard/approved-dashboard.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /(^|})\s*(body|html|:root|button|h1|a|\*)\s*\{/m);
  for (const token of ['--ga-font', '--ga-paper', '--ga-background', '--ga-sidebar-width', '--ga-active', '--ga-accent', '--ga-panel-gap', '--ga-panel-radius']) assert.ok(css.includes(token));
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /font-size: 12px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.ga-navigation-container\[data-open='true'\]/);
  assert.match(css, /grid-template-columns: repeat\(6, minmax\(0, 1fr\)\)/);
});
