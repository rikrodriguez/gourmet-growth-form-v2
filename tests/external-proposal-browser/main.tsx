import React from 'react';
import { createRoot } from 'react-dom/client';
import { LeadLinkHistorySection } from '../../src/office/dashboard/LeadLinkHistorySection';
import { PersistedQuoteWorkspace } from '../../src/office/dashboard/PersistedQuoteWorkspace';
import { ExternalProposalPanel } from '../../src/office/dashboard/ExternalProposalPanel';
import type { DashboardLeadLinkAccessSource, LeadLinkClient } from '../../src/office/dashboard/lead-link-access';
import type { EventQuoteClient } from '../../src/office/event-quote-client';
import type { ExternalProposalClient } from '../../src/office/external-proposal-contracts';
import '../../src/office/dashboard/event-workflow.css';
const scope = { organizationId: 'TEST-ORG', workspaceId: 'TEST-WORKSPACE', mode: 'test' as const };
const listeners = new Set<() => void>();
async function call(action: string, body = {}, signal?: AbortSignal) {
 const response = await fetch('/__proposal-fixture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...body }), signal });
 if (!response.ok) throw new Error('Fixture rejected'); return response.json();
}
const source: DashboardLeadLinkAccessSource = { read: signal => call('access', {}, signal), subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; } };
const history: LeadLinkClient = { read: (leadId, signal) => call('history', { target: { leadId } }, signal) };
const quotes: EventQuoteClient = {
 status: signal => call('status', {}, signal), read: (eventId, signal) => call('quote-read', { target: { eventId } }, signal),
 execute: (eventId, command, _csrf, signal) => call('quote-command', { target: { eventId }, command }, signal),
};
const proposals: ExternalProposalClient = {
 // Intentionally ignores abort to verify that late adapters cannot restore a previous lead.
 read: target => call('proposal-read', { target }), execute: (target, command, signal) => call('proposal-command', { target, command }, signal),
};
async function control(value: string) { await call('control', { control: value }); if (value === 'withdraw') listeners.forEach(cb => cb()); }
function Fixture() {
 return <main style={{ maxWidth: 1120, margin: 'auto', padding: 12, fontFamily: 'sans-serif' }}>
  <h1>Propuesta existente · demostración sintética</h1><p>Sin conexión a proveedores. Sólo revisión interna; sin envío ni aceptación del cliente.</p>
  <aside aria-label="Controles sintéticos" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
   {([['recipient','Cambiar destinatario sintético'],['document','Publicar documento sintético v2'],['reference','Usar referencia sin documento'],['withdraw','Retirar acceso sintético'],['delay','Demorar respuesta sintética'],['lost-response','Perder próxima respuesta sintética'],['restart','Reiniciar servicio sintético']] as const).map(([value,label]) => <button key={value} onClick={() => void control(value)}>{label}</button>)}
  </aside>
  <LeadLinkHistorySection source={source} client={history} renderForLead={({ leadId, identityKey }) => {
   const suffix = leadId.endsWith('a') ? 'a' : 'b', eventId = `SYNTHETIC-EVENT-${suffix}`;
   const target = { leadId, eventId, proposalId: `SYNTHETIC-PROPOSAL-${suffix}` };
   return <PersistedQuoteWorkspace key={leadId} client={quotes} identityKey={identityKey} eventId={eventId} externalProposal={({ briefDigest, dirty }) => dirty ? <p role="status">El brief cambió. Guarda y vuelve a revisar la propuesta externa.</p> : <ExternalProposalPanel key={briefDigest} client={proposals} target={target} identityKey={identityKey} scope={scope} />} />;
  }} />
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
