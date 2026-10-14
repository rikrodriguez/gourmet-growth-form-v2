import React, { useCallback, useEffect, useRef, useState } from 'react';
import { eventQuoteClient, type EventQuoteClient } from '../event-quote-client';
import { PersistedQuoteWorkspace } from './PersistedQuoteWorkspace';
import { bindDashboardQuoteClient, DashboardQuoteAccessGate, quoteAccessExpiresAt, unconfiguredDashboardQuoteAccess, validateDashboardQuoteAccess,
  type DashboardQuoteAccessSource, type DashboardQuoteGrant } from './quote-access';

type Binding = { source: DashboardQuoteAccessSource; client: EventQuoteClient; grant: DashboardQuoteGrant; boundClient: EventQuoteClient; current(): boolean };
export function PersistedQuoteSection({ source = unconfiguredDashboardQuoteAccess, client = eventQuoteClient }: {
  source?: DashboardQuoteAccessSource; client?: EventQuoteClient;
}) {
  const [binding, setBinding] = useState<Binding | null>(null);
  const [phase, setPhase] = useState<'closed' | 'reading' | 'unconfigured' | 'unavailable' | 'ready'>('closed');
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [openedId, setOpenedId] = useState('');
  const subscribedSource = useRef<DashboardQuoteAccessSource | null>(null);
  const gate = useRef(new DashboardQuoteAccessGate());
  const owner = useRef({ source, client });
  // Do not display or accept a response from the previous source even before effect cleanup.
  if (owner.current.source !== source || owner.current.client !== client) { gate.current.cancel(); owner.current = { source, client }; }
  const withdraw = useCallback((reason: string | null = null) => {
    gate.current.cancel(); setBinding(null); setPhase('closed'); setNotice(reason); setSelectedId(''); setOpenedId('');
  }, []);
  useEffect(() => {
    withdraw();
    let active = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = source.subscribe(() => { if (active) withdraw('El acceso cambió o se retiró. Verifica de nuevo la identidad existente.'); });
      if (typeof unsubscribe !== 'function') throw new Error('Invalid subscription');
      subscribedSource.current = source;
    }
    catch { unsubscribe = undefined; subscribedSource.current = null; withdraw('No se pudo verificar la continuidad del acceso.'); }
    return () => { active = false; subscribedSource.current = null; gate.current.cancel(); unsubscribe?.(); };
  }, [source, client, withdraw]);
  useEffect(() => {
    const hide = () => withdraw('El expediente se cerró al salir o cambiar de página. Verifica de nuevo el acceso.');
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', hide);
    window.addEventListener('popstate', hide); window.addEventListener('hashchange', hide); visibility();
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', hide); window.removeEventListener('popstate', hide); window.removeEventListener('hashchange', hide); };
  }, [withdraw]);
  useEffect(() => {
    if (!binding) return;
    const timer = window.setTimeout(() => withdraw('El acceso o el catálogo venció. Verifica de nuevo para continuar.'), Math.max(0, quoteAccessExpiresAt(binding.grant) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [binding, withdraw]);
  async function verify() {
    if (subscribedSource.current !== source) { withdraw('No se pudo verificar la continuidad del acceso.'); return; }
    const request = gate.current.start(); setBinding(null); setSelectedId(''); setOpenedId(''); setPhase('reading'); setNotice(null);
    try {
      const access = validateDashboardQuoteAccess(await source.read(request.signal));
      if (!request.current() || owner.current.source !== source || owner.current.client !== client) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { withdraw(); return; }
      if (access.state !== 'ready') { setPhase(access.state); return; }
      const boundClient = bindDashboardQuoteClient(client, access, request, Date.now, () => {
        if (request.current()) withdraw('El servidor retiró o no pudo verificar este acceso. Verifica de nuevo antes de continuar.');
      });
      setBinding({ source, client, grant: access, boundClient, current: request.current }); setPhase('ready');
    } catch { if (request.current()) { gate.current.cancel(); setBinding(null); setPhase('unavailable'); } }
  }
  const current = binding && binding.source === source && binding.client === client && binding.current() && quoteAccessExpiresAt(binding.grant) > Date.now() ? binding : null;
  const permittedSelection = !!current && current.grant.eventIds.includes(selectedId);
  return <section className="gourmet-event-workspace" data-testid="dashboard-persisted-quotes" aria-labelledby="dashboard-persisted-title">
    <div className="gew-card"><span className="gew-eyebrow">Guardadas · acceso separado del ejemplo</span><h2 id="dashboard-persisted-title">Cotizaciones guardadas</h2>
      <p className="gew-muted">Verifica una identidad existente, sus eventos permitidos y el catálogo autorizado. No se inicia ninguna sesión ni se consultan proveedores.</p>
      <p className="gew-muted">Importes, cobros y disponibilidad desconocidos hasta su verificación. Esta sección no alimenta las métricas del dashboard.</p>
      <div className="gew-actions"><button type="button" className="gew-button gew-button-primary" data-testid="dashboard-verify-quotes" disabled={phase === 'reading'} onClick={() => void verify()}>{phase === 'reading' ? 'Verificando acceso…' : 'Verificar acceso a guardadas'}</button>
        {current && <button type="button" className="gew-button" onClick={() => withdraw('Expediente cerrado. Vuelve a verificar para consultar.')}>Cerrar expediente</button>}</div>
      {notice && <p className="gew-notice" role="status">{notice}</p>}
      {!current && phase !== 'reading' && <p className="gew-notice gew-notice-warning" role="status">{phase === 'unavailable' ? 'No se pudo verificar el acceso. La identidad, los permisos y el catálogo deben estar vigentes.' : phase === 'unconfigured' || source === unconfiguredDashboardQuoteAccess ? 'Sin conexión operativa configurada. Se requiere identidad existente y catálogo autorizado; las cotizaciones guardadas permanecen cerradas.' : 'Acceso cerrado. Aún no se ha consultado ninguna cotización guardada.'}</p>}
      {current && <><p className="gew-muted">{current.grant.scope.mode === 'test' ? 'Ámbito de prueba aislado' : 'Ámbito comercial verificado'} · {current.grant.scope.organizationId} / {current.grant.scope.workspaceId}</p>
        {current.grant.eventIds.length ? <><div className="gew-editor-fields"><label>Evento autorizado<select data-testid="dashboard-quote-event" value={selectedId} onChange={event => { setSelectedId(event.target.value); setOpenedId(''); }}><option value="">Selecciona un ID de evento</option>{current.grant.eventIds.map(id => <option key={id} value={id}>{id}</option>)}</select></label></div>
          <div className="gew-actions"><button type="button" className="gew-button" data-testid="dashboard-open-quote" disabled={!permittedSelection || openedId === selectedId} onClick={() => { if (permittedSelection) setOpenedId(selectedId); }}>Consultar evento seleccionado</button></div></>
          : <p className="gew-notice" role="status">No se proporcionaron IDs de eventos autorizados. El estado de otros eventos es desconocido.</p>}</>}
    </div>
    {current && openedId && current.grant.eventIds.includes(openedId) && <PersistedQuoteWorkspace key={openedId} client={current.boundClient} identityKey={current.grant.identityKey} eventId={openedId} />}
  </section>;
}
