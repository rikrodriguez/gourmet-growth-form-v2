import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LeadLinkHistorySection } from '../../src/office/dashboard/LeadLinkHistorySection';
import { PersistedQuoteWorkspace } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { ExternalProposalPanel } from '../../src/office/dashboard/ExternalProposalPanel';
import type { DashboardLeadLinkAccessSource, LeadLinkClient } from '../../src/office/dashboard/lead-link-access';
import type { EventQuoteClient } from '../../src/office/event-quote-client';
import type { ExternalProposalClient } from '../../src/office/external-proposal-contracts';
import { TEST_PROPOSAL_API as API, TEST_PROPOSAL_CSRF, TEST_PROPOSAL_IDENTITY } from '../../src/office/external-proposal-contracts';
import '../../src/office/dashboard/event-workflow.css';
const target = { leadId: 'demo-history-a', eventId: 'SYNTHETIC-EVENT-a', proposalId: 'SYNTHETIC-PROPOSAL-a' };
const scope = { organizationId: 'TEST-ORG', workspaceId: 'TEST-WORKSPACE', mode: 'test' as const };
const listeners = new Set<() => void>(); let session: { identityKey: string; csrfToken: string } | null = null;
async function request(path: string, signal?: AbortSignal, command?: unknown) {
 const headers: Record<string,string> = { Accept: 'application/json' };
 if (session) headers[TEST_PROPOSAL_IDENTITY] = session.identityKey;
 if (command) { headers['Content-Type'] = 'application/json'; if (session) headers[TEST_PROPOSAL_CSRF] = session.csrfToken; }
 const response = await fetch(path, { method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers, body: command ? JSON.stringify(command) : undefined, signal });
 if (!response.ok) throw new Error('Test access changed'); return response.json();
}
const source: DashboardLeadLinkAccessSource = { async read(signal) {
 const result = await request(`${API}/access`, signal); if (signal.aborted) throw new Error('Cancelled');
 session = { identityKey: result.access.identityKey, csrfToken: result.csrfToken }; return result.access;
}, subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; } };
const history: LeadLinkClient = { read: (_lead, signal) => request(`${API}/history`, signal) };
const quotes: EventQuoteClient = { status: signal => request('/__durable-quote/status', signal), read: (_event, signal) => request('/__durable-quote/read', signal), execute: async () => { throw new Error('Existing brief is read-only in this fixture'); } };
const proposals: ExternalProposalClient = { read: (_target, signal) => request(`${API}/proposal`, signal), execute: (_target, command, signal) => request(`${API}/commands`, signal, command) };
function Fixture() {
 const [notice,setNotice] = useState(''), [busy,setBusy] = useState(false);
 async function control(action: string) {
  setBusy(true);
  try {
   const path = action === 'restart' ? '/__durable-control' : '/__durable-fixture/control';
   await request(path, undefined, { action });
   if (action !== 'version') { session = null; listeners.forEach(cb => cb()); }
   setNotice(action === 'restart' ? 'Proceso de prueba reiniciado. Verifica de nuevo para recuperar el expediente.' : action === 'version' ? 'Nueva versión guardada. Consulta y revisa la propuesta otra vez.' : 'Los permisos de prueba cambiaron. Verifica de nuevo el acceso.');
  } catch { setNotice('No se pudo completar el control sintético.'); }
  finally { setBusy(false); }
 }
 return <main style={{ maxWidth: 1120, margin: 'auto', padding: 12, fontFamily: 'sans-serif' }}><h1>Propuesta durable · prueba sintética</h1>
  <p>Expediente y documento guardados en el servicio de prueba. Aprobación interna, sin envío ni aceptación del cliente.</p>
  <aside aria-label="Controles de prueba durable" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
   {([['restart','Reiniciar proceso de prueba'],['version','Publicar versión sintética nueva'],['readonly','Retirar aprobación sintética'],['revoke','Retirar acceso sintético'],['restore','Restaurar acceso sintético']] as const).map(([action,label]) => <button disabled={busy} key={action} onClick={() => void control(action)}>{label}</button>)}
  </aside><p role="status">{notice}</p>
  <LeadLinkHistorySection source={source} client={history} renderForLead={({ leadId, identityKey }) => leadId === target.leadId ? <PersistedQuoteWorkspace key={identityKey} client={quotes} eventId={target.eventId} identityKey={identityKey}
   externalProposal={({ briefDigest }) => <ExternalProposalPanel key={briefDigest} client={proposals} target={target} identityKey={identityKey} scope={scope} />} /> : null} />
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
