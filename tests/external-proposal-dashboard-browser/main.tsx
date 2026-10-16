import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardPage } from '../../src/office/DashboardPage';
import { createTestProposalDashboardIntegration } from '../../src/office/dashboard/test-proposal-integration';
import type { EventQuoteClient } from '../../src/office/event-quote-client';
import { TEST_PROPOSAL_IDENTITY } from '../../src/office/external-proposal-contracts';
import '../../src/office/office.css';
import '../../src/office/dashboard.css';
import '../../src/office/dashboard-navigation.css';
import '../../src/office/dashboard/approved-dashboard.css';
import '../../src/office/dashboard/event-workflow.css';
import '../../src/office/dashboard/dashboard-integration.css';
import '../../src/office/lead-link-history.css';
const listeners = new Set<() => void>();
async function quoteRead(path: string, signal: AbortSignal, identityKey?: string) {
 const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal, headers: { Accept: 'application/json', [TEST_PROPOSAL_IDENTITY]: identityKey ?? '' } });
 if (!response.ok) throw new Error('Fixture access changed'); return response.json();
}
const quotes: EventQuoteClient = {
 status: (signal, identity) => quoteRead('/__durable-quote/status', signal, identity),
 read: (_event, signal, identity) => quoteRead('/__durable-quote/read', signal, identity),
 execute: async () => { throw new Error('Fixture brief is read-only'); },
};
const integration = createTestProposalDashboardIntegration({ quoteClient: quotes, subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; } });
function Fixture() {
 const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
 async function control(action: string) {
  setBusy(true);
  try {
   const path = ['restart', 'lead'].includes(action) ? '/__durable-control' : '/__durable-fixture/control';
   const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
   if (!response.ok) throw new Error('Fixture control rejected');
   await response.json();
   if (action !== 'version') listeners.forEach(listener => listener());
   setNotice(action === 'lead' ? 'El servidor cambió al otro expediente sintético. Verifica su acceso existente.' : action === 'restart' ? 'API reiniciada con otro PID y Pool. Verifica de nuevo.' : 'Cambio sintético guardado. Consulta y revisa de nuevo.');
  } catch { setNotice('No se pudo completar el control sintético.'); }
  finally { setBusy(false); }
 }
 return <><aside aria-label="Controles TEST_ONLY del Dashboard" style={{ padding: 12, background: '#fff9e8', overflowWrap: 'anywhere' }}>
  <strong>Dashboard existente · TEST_ONLY · datos sintéticos</strong><p>Proveedor synthetic. Aprobación interna sin envío ni aceptación del cliente.</p>
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{([['lead', 'Cambiar lead sintético en servidor'], ['restart', 'Reiniciar proceso de prueba'], ['version', 'Publicar versión sintética nueva'], ['readonly', 'Retirar aprobación sintética'], ['revoke', 'Retirar acceso sintético'], ['restore', 'Restaurar acceso sintético']] as const).map(([action, label]) => <button key={action} disabled={busy} onClick={() => void control(action)}>{label}</button>)}</div>
  <p role="status">{notice}</p>
 </aside><DashboardPage testProposalIntegration={integration} /></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
