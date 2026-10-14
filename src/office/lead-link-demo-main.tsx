/** Explicit synthetic test entry; not imported by the production dashboard bundle. */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardPage } from './DashboardPage';
import views from './lead-link-demo-projections.json';
import type { LeadLinkView } from './lead-link-view-contracts';
import type { LeadLinkResponse } from './lead-link-response';
import type { DashboardLeadLinkAccessSource, LeadLinkClient } from './dashboard/lead-link-access';
import './office.css';
import './dashboard.css';
import './dashboard-navigation.css';
import './dashboard/approved-dashboard.css';
import './dashboard/event-workflow.css';
import './dashboard/dashboard-integration.css';
import './lead-link-history.css';
const scope = { organizationId:'synthetic-org',workspaceId:'synthetic-workspace',mode:'test' as const };
const listeners = new Set<() => void>();
let revoked = false, delayNext = false, reads = 0;
const source: DashboardLeadLinkAccessSource = {
 async read() { return revoked ? {state:'unavailable'} : {state:'ready',identityKey:'synthetic-test-identity',durableIdentity:false,scope,expiresAtMs:Date.now()+600000,canRead:true,canOpen:true,leadIds:views.map(v=>v.leadId)}; },
 subscribe(callback) { listeners.add(callback);return()=>{listeners.delete(callback);}; },
};
const client: LeadLinkClient = {
 async read(leadId) {
  reads += 1;
  const history = views.find(v=>v.leadId===leadId) as LeadLinkView;
  const response: LeadLinkResponse = {identityKey:'synthetic-test-identity',scope,leadId,history,openingSession:{canOpen:true,csrfToken:'synthetic_open_csrf_fixture_not_credential',expiresAtMs:Date.now()+600000},
   agreement:leadId===views[0].leadId ? {leadId,guests:45,menu:'Menú acordado DEMO',amountLabel:'USD 900 DEMO',verifiedAt:'2026-10-13T20:05:00Z',evidenceLabel:'Conversación verificada sintética'} : null};
  if(delayNext){delayNext=false;await new Promise(resolve=>setTimeout(resolve,600));} // Deliberately ignores abort for regression coverage.
  return response;
 },
};
function Fixture() {
 const [revision,setRevision]=useState(0);
 return <><aside aria-label="Controles de prueba sintética"><p>Fixture sintética de historial. No es una fuente de acceso comercial.</p>
  <button onClick={()=>{revoked=true;listeners.forEach(cb=>cb());setRevision(v=>v+1);}}>Retirar identidad sintética</button>
  <button onClick={()=>{revoked=false;setRevision(v=>v+1);}}>Restablecer identidad sintética</button>
  <button onClick={()=>{delayNext=true;}}>Demorar próxima consulta sintética</button>
  <button onClick={()=>setRevision(v=>v+1)}>Consultar contador sintético</button><span data-testid="history-read-counter">{reads}</span><span hidden>{revision}</span>
 </aside><DashboardPage initialSection="events" leadLinkAccessSource={source} leadLinkClient={client}/></>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
