import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LeadLinkHistoryPanel, type LeadLinkOpeningContext } from '../LeadLinkHistoryPanel';
import type { LeadLinkResponse } from '../lead-link-response';
import { bindLeadLinkClient, leadLinkClient, LeadLinkReadGate, unconfiguredLeadLinkAccess, validateLeadLinkAccess,
  type DashboardLeadLinkAccessSource, type DashboardLeadLinkGrant, type LeadLinkClient } from './lead-link-access';
type Binding = { source: DashboardLeadLinkAccessSource; client: LeadLinkClient; grant: DashboardLeadLinkGrant; bound: LeadLinkClient; current(): boolean };
export function LeadLinkHistorySection({ source = unconfiguredLeadLinkAccess, client = leadLinkClient, renderForLead }: { source?: DashboardLeadLinkAccessSource; client?: LeadLinkClient; renderForLead?(context: { leadId: string; identityKey: string }): ReactNode }) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [phase, setPhase] = useState<'closed' | 'verifying' | 'unconfigured' | 'unavailable' | 'ready' | 'reading'>('closed');
  const [selected, setSelected] = useState(''); const [result, setResult] = useState<LeadLinkResponse | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const accessGate = useRef(new LeadLinkReadGate()); const readGate = useRef(new LeadLinkReadGate());
  const subscribed = useRef<DashboardLeadLinkAccessSource | null>(null); const owner = useRef({ source, client });
  if (owner.current.source !== source || owner.current.client !== client) { accessGate.current.cancel(); readGate.current.cancel(); owner.current = { source, client }; }
  const close = useCallback((reason: string | null = null) => {
    accessGate.current.cancel(); readGate.current.cancel(); setBinding(null); setResult(null); setSelected(''); setPhase('closed'); setNotice(reason);
  }, []);
  useEffect(() => {
    close(); let active = true; let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = source.subscribe(() => { if (active) close('El acceso cambió. Verifica de nuevo para consultar el historial.'); });
      if (typeof unsubscribe !== 'function') throw new Error('Invalid subscription'); subscribed.current = source;
    } catch { subscribed.current = null; close('No se pudo verificar la continuidad del acceso.'); }
    return () => { active = false; subscribed.current = null; accessGate.current.cancel(); readGate.current.cancel(); unsubscribe?.(); };
  }, [source, client, close]);
  useEffect(() => {
    const hide = () => close('El historial se cerró al salir o navegar.');
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', hide); window.addEventListener('popstate', hide); window.addEventListener('hashchange', hide); visibility();
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', hide); window.removeEventListener('popstate', hide); window.removeEventListener('hashchange', hide); };
  }, [close]);
  useEffect(() => {
    if (!binding) return;
    const timer = window.setTimeout(() => close('El acceso venció. Verifica de nuevo para continuar.'), Math.max(0, binding.grant.expiresAtMs - Date.now()));
    return () => window.clearTimeout(timer);
  }, [binding, close]);
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => close('El permiso de consulta o apertura venció.'), Math.max(0,result.openingSession.expiresAtMs-Date.now()));
    return () => window.clearTimeout(timer);
  }, [result, close]);
  async function verify() {
    if (subscribed.current !== source) { close('No se pudo verificar la continuidad del acceso.'); return; }
    readGate.current.cancel(); const request = accessGate.current.start(); setBinding(null); setResult(null); setSelected(''); setNotice(null); setPhase('verifying');
    try {
      const access = validateLeadLinkAccess(await source.read(request.signal));
      if (!request.current() || owner.current.source !== source || owner.current.client !== client) return;
      if (document.visibilityState === 'hidden') { close(); return; }
      if (access.state !== 'ready') { setPhase(access.state); return; }
      setBinding({ source, client, grant: access, bound: bindLeadLinkClient(client, access, request), current: request.current }); setPhase('ready');
    } catch { if (request.current()) { close(); setPhase('unavailable'); } }
  }
  const current = binding && binding.source === source && binding.client === client && binding.current() && binding.grant.expiresAtMs > Date.now() ? binding : null;
  async function read() {
    if (!current || !current.grant.leadIds.includes(selected)) return;
    const bindingAtStart = current, leadId = selected, request = readGate.current.start(); setResult(null); setNotice(null); setPhase('reading');
    try {
      const response = await bindingAtStart.bound.read(leadId, request.signal);
      if (!request.current() || !bindingAtStart.current() || owner.current.source !== source || owner.current.client !== client) return;
      if (document.visibilityState === 'hidden') { close(); return; }
      setResult(response); setPhase('ready');
    } catch { if (request.current()) close('No se pudo verificar el historial o su acceso. Verifica de nuevo antes de consultar.'); }
  }
  const openingContext: LeadLinkOpeningContext | null = current && result?.openingSession.canOpen && result.openingSession.csrfToken ? { identityKey: result.identityKey, csrfToken: result.openingSession.csrfToken, expiresAtMs: result.openingSession.expiresAtMs, current: () => current.current() && current.source === owner.current.source && current.client === owner.current.client && current.grant.canOpen && current.grant.expiresAtMs > Date.now() } : null;
  return <section className="gourmet-event-workspace" data-testid="dashboard-lead-history" aria-label="Historial guardado por lead">
    <div className="gew-card"><span className="gew-eyebrow">Guardadas · lectura histórica por lead</span><h2>Enlaces y atribución del lead</h2>
      <p className="gew-muted">Selecciona un lead autorizado. Esta selección es independiente del expediente; no se vinculan por nombre. No abre destinos ni consulta proveedores automáticamente.</p>
      <div className="gew-actions"><button type="button" className="gew-button" disabled={phase === 'verifying'} onClick={() => void verify()}>{phase === 'verifying' ? 'Verificando historial…' : 'Verificar acceso al historial'}</button>
        {current && <button type="button" className="gew-button" onClick={() => close('Historial cerrado.')}>Cerrar historial</button>}</div>
      {notice && <p className="gew-notice" role="status">{notice}</p>}
      {!current && phase !== 'verifying' && <p className="gew-notice" role="status">{phase === 'unavailable' ? 'No se pudo verificar la identidad y los permisos del historial.' : phase === 'unconfigured' || source === unconfiguredLeadLinkAccess ? 'Sin fuente de historial configurada. Acceso cerrado; no se han importado leads.' : 'Acceso cerrado. Ningún historial consultado.'}</p>}
      {current && <><p className="gew-muted">{current.grant.scope.mode === 'test' ? 'Ámbito de prueba aislado.' : 'Lectura autorizada del ámbito comercial.'} Los enlaces conservados no actualizan acuerdos, cotizaciones ni métricas.</p>
        <label>Lead autorizado<select aria-label="Lead autorizado" value={selected} onChange={event => { readGate.current.cancel(); setResult(null); setNotice(null); setPhase('ready'); setSelected(event.target.value); }}><option value="">Selecciona un lead</option>{current.grant.leadIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
        <div className="gew-actions"><button type="button" className="gew-button gew-button-primary" disabled={!current.grant.leadIds.includes(selected) || phase === 'reading'} onClick={() => void read()}>{phase === 'reading' ? 'Consultando historial…' : 'Consultar historial del lead'}</button></div>
        {current.grant.leadIds.length === 0 && <p>No hay leads autorizados en este alcance.</p>}
        {result && result.leadId === selected && <><LeadLinkHistoryPanel leadId={selected} history={result.history} agreement={result.agreement} openingContext={openingContext} />{renderForLead?.({ leadId: selected, identityKey: result.identityKey })}</>}</>}
    </div>
  </section>;
}
