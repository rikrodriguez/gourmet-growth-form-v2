/** Explicit local test harness. Never imported into production servers/builds. */
import { createServer } from 'vite';
import { proposalFixture } from '../office/external-proposal-fixtures';
import { projectLeadLinks } from '../../src/office/backend/lead-link-view';
import { normalizeHistoricalLink } from '../../src/office/backend/lead-link-history';
import { testScope } from '../office/event-quote-fixtures';
let fixture = await proposalFixture();
let delayNext = false, failNext = false;
const vite = await createServer({ configFile: false, root: process.cwd(), server: { host: '127.0.0.1', port: 4196, strictPort: true },
 plugins: [{ name: 'synthetic-proposal-harness', configureServer(server) {
  server.middlewares.use('/__proposal-fixture', async (req, res) => {
   res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8');
   try {
    if (req.method !== 'POST' || req.headers.origin && req.headers.origin !== 'http://127.0.0.1:4196') throw new Error('Local fixture only');
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('Too large'); }
    const { action, target, command, control } = JSON.parse(raw);
    let value: unknown;
    if (action === 'reset') { fixture = await proposalFixture(); delayNext = false; failNext = false; value = null; }
    else if (action === 'access') {
     const a = fixture.authorities.get(fixture.targets[0].leadId)!;
     value = { state: 'ready', ...a.lead, canOpen: false };
    } else if (action === 'history') {
     const a = fixture.authorities.get(target.leadId)!, t = fixture.targets.find(t => t.leadId === target.leadId)!;
     const link = normalizeHistoricalLink(fixture.documents.get(t.proposalId)!.historicalLink);
     value = { identityKey: a.lead.identityKey, scope: testScope, leadId: t.leadId,
      history: projectLeadLinks({ leadId: t.leadId, ...a.source }, [link], new Map()), agreement: null,
      openingSession: { canOpen: false, csrfToken: null, expiresAtMs: a.lead.expiresAtMs } };
    } else if (action === 'status') {
     const s = await fixture.quoteService.status(testScope, fixture.actor);
     value = { ...s, session: { mode: 'test', canWrite: true, canApprove: true, csrfToken: 'existing_fixture_csrf_not_a_credential', expiresAtMs: fixture.actor.expiresAtMs }, externalEffectsEnabled: false };
    } else if (action === 'quote-read') value = await fixture.quoteService.read(testScope, fixture.actor, target.eventId);
    else if (action === 'quote-command') {
     if (command.action !== 'brief') throw new Error('Only saved brief changes in this cut');
     value = await fixture.quoteService.execute(testScope, fixture.actor, target.eventId, command);
    } else if (action === 'proposal-read') {
     value = await fixture.service.read(target);
     if (delayNext) { delayNext = false; await new Promise(r => setTimeout(r, 600)); }
    } else if (action === 'proposal-command') {
     value = await fixture.service.execute(target, command);
     if (failNext) { failNext = false; throw new Error('Synthetic lost response after commit'); }
    } else if (action === 'control') {
     const t = fixture.targets[0], doc = fixture.documents.get(t.proposalId)!;
     if (control === 'recipient') await fixture.changeBrief(t);
     if (control === 'document') { doc.sourceVersion = 'v2'; doc.content += '\nVersión sintética actualizada.'; }
     if (control === 'reference') { doc.sourceVersion = 'reference-v1'; doc.content = null; }
     if (control === 'withdraw') fixture.withdraw();
     if (control === 'delay') delayNext = true;
     if (control === 'lost-response') failNext = true;
     if (control === 'restart') fixture.service = fixture.restart();
     value = null;
    } else throw new Error('Unknown fixture command');
    res.end(JSON.stringify(value));
   } catch { res.statusCode = 403; res.end(JSON.stringify({ error: 'SYNTHETIC_REQUEST_REJECTED' })); }
  });
 } }] });
await vite.listen();
process.stdout.write('Synthetic proposal browser fixture: http://127.0.0.1:4196/tests/external-proposal-browser/index.html\n');
process.once('SIGTERM', () => { void vite.close(); });
