import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { DashboardPage } from '../../src/office/DashboardPage';
import { createTestProposalDashboardIntegration } from '../../src/office/dashboard/test-proposal-integration';
import type { EventQuoteClient } from '../../src/office/event-quote-client';
import { TEST_PROPOSAL_API as API, TEST_PROPOSAL_IDENTITY as ID } from '../../src/office/external-proposal-contracts';
const signal = () => new AbortController().signal;
function projection() {
 return { access: { state: 'ready', identityKey: `proposal-${'a'.repeat(43)}`, durableIdentity: true,
  scope: { organizationId: 'TEST-ORG', workspaceId: 'TEST-WORKSPACE', mode: 'test' }, expiresAtMs: Date.now() + 60000,
  canRead: true, canOpen: false, leadIds: ['SYNTHETIC-LEAD'] },
  target: { leadId: 'SYNTHETIC-LEAD', eventId: 'SYNTHETIC-EVENT', proposalId: 'SYNTHETIC-PROPOSAL' }, csrfToken: 'existing_synthetic_csrf_1234' };
}
const quotes: EventQuoteClient = { async status() { throw new Error('No automatic quote read'); }, async read() { throw new Error('No automatic quote read'); }, async execute() { throw new Error('No quote write'); } };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
test('the actual Dashboard stays closed without injection; injected composition mounts only the existing lead gate', () => {
 let requests = 0;
 const integration = createTestProposalDashboardIntegration({ quoteClient: quotes, subscribe: () => () => {}, fetch: async () => { requests++; return json(projection()); } });
 const normal = renderToStaticMarkup(<DashboardPage initialSection="quotes" />);
 assert.match(normal, /dashboard-persisted-quotes/); assert.match(normal, /Sin fuente de historial configurada/);
 for (const initialSection of ['quotes', 'events'] as const) {
  const injected = renderToStaticMarkup(<DashboardPage initialSection={initialSection} testProposalIntegration={integration} />);
  assert.match(injected, /dashboard-lead-history/); assert.doesNotMatch(injected, /dashboard-persisted-quotes|persisted-quote-workspace|external-proposal-panel|<select/);
 }
 assert.equal(requests, 0);
});
test('commercial, contradictory, broad, expired and non-durable server projections cannot mount an expediente', async () => {
 const changes = [
  (v: ReturnType<typeof projection>) => { v.access.scope.mode = 'commercial'; },
  (v: ReturnType<typeof projection>) => { v.access.durableIdentity = false; },
  (v: ReturnType<typeof projection>) => { v.access.expiresAtMs = Date.now() - 1; },
  (v: ReturnType<typeof projection>) => { v.access.canRead = false; },
  (v: ReturnType<typeof projection>) => { v.access.canOpen = true; },
  (v: ReturnType<typeof projection>) => { v.access.leadIds.push('OTHER-LEAD'); },
  (v: ReturnType<typeof projection>) => { v.target.leadId = 'OTHER-LEAD'; },
  (v: ReturnType<typeof projection>) => { v.target.eventId = '../event'; },
  (v: ReturnType<typeof projection>) => { v.target.proposalId = 'constructor'; },
  (v: ReturnType<typeof projection>) => { Object.assign(v.target, { actorId: 'untrusted' }); },
  (v: ReturnType<typeof projection>) => { v.access.identityKey = 'raw_unbound_identity'; },
  (v: ReturnType<typeof projection>) => { v.csrfToken = ''; },
 ];
 for (const change of changes) {
  const value = projection(); change(value);
  const integration = createTestProposalDashboardIntegration({ quoteClient: quotes, subscribe: () => () => {}, fetch: async () => json(value) });
  await assert.rejects(() => integration.source.read(signal()));
  assert.equal(integration.renderForLead({ leadId: value.target.leadId, identityKey: value.access.identityKey }), null);
 }
});
test('only the detached server-mapped lead and identity mount the existing workspace; no guessed IDs', async () => {
 const value = projection(); let reads = 0;
 const integration = createTestProposalDashboardIntegration({ quoteClient: quotes, subscribe: () => () => {}, fetch: async url => {
  reads++; assert.equal(url, `${API}/access`); return json(value);
 } });
 const access = await integration.source.read(signal()); assert.equal(access.state, 'ready');
 if (access.state !== 'ready') throw new Error('ready required');
 access.leadIds[0] = 'MUTATED-LEAD';
 assert.equal(integration.renderForLead({ leadId: 'MUTATED-LEAD', identityKey: value.access.identityKey }), null);
 assert.equal(integration.renderForLead({ leadId: value.target.leadId, identityKey: 'other' }), null);
 const node = integration.renderForLead({ leadId: value.target.leadId, identityKey: value.access.identityKey });
 assert.match(renderToStaticMarkup(node), /persisted-quote-workspace/);
 assert.equal(node, integration.renderForLead({ leadId: value.target.leadId, identityKey: value.access.identityKey }));
 assert.equal(reads, 1);
});
test('withdrawal during access verification cannot restore an old lead, even if transport ignores cancellation', async () => {
 let withdraw!: () => void, release!: () => void;
 const waiting = new Promise<void>(resolve => { release = resolve; });
 const integration = createTestProposalDashboardIntegration({ quoteClient: quotes, subscribe(listener) { withdraw = listener; return () => {}; }, fetch: async () => { await waiting; return json(projection()); } });
 let notifications = 0; const unsubscribe = integration.source.subscribe(() => { notifications++; });
 const pending = integration.source.read(signal()); withdraw(); release(); await assert.rejects(() => pending);
 const value = projection(); assert.equal(integration.renderForLead({ leadId: value.target.leadId, identityKey: value.access.identityKey }), null);
 assert.equal(notifications, 1); unsubscribe();
});
test('old lead requests and replies cannot survive a new server projection or host withdrawal', async () => {
 let value = projection(), withdraw!: () => void, release!: () => void;
 const waiting = new Promise<void>(resolve => { release = resolve; }); const requests: string[] = [];
 const integration = createTestProposalDashboardIntegration({ quoteClient: quotes, subscribe(listener) { withdraw = listener; return () => {}; }, fetch: async (url, init) => {
  requests.push(String(url));
  if (String(url).endsWith('/access')) return json(value);
  assert.equal(new Headers(init?.headers).get(ID), value.access.identityKey); await waiting; return json({ leadId: 'OLD-LEAD' });
 } });
 const unsubscribe = integration.source.subscribe(() => {}); await integration.source.read(signal());
 await assert.rejects(() => integration.historyClient.read('OTHER-LEAD', signal())); assert.equal(requests.length, 1);
 const pending = integration.historyClient.read(value.target.leadId, signal());
 value = projection(); value.target.leadId = 'LEAD-B'; value.access.leadIds = ['LEAD-B']; value.access.identityKey = `proposal-${'b'.repeat(43)}`;
 await integration.source.read(signal()); release(); await assert.rejects(() => pending);
 withdraw(); await assert.rejects(() => integration.historyClient.read('LEAD-B', signal())); unsubscribe();
});
test('the normal entrypoints never create the fixture integration or register its API', () => {
 for (const file of ['src/office/main.tsx', 'src/office/backend/server.ts', 'src/office/backend/staging-server.ts', 'src/office/backend/staging-app.ts', 'src/office/backend/http.ts']) {
  const source = readFileSync(file, 'utf8'); assert.doesNotMatch(source, /createTestProposalDashboardIntegration|createTestProposalApi|testProposalIntegration=/);
 }
});
