import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalQueue, Channel, Conversation, DashboardReadSource, DashboardReviewSource, DashboardSnapshot, Stage } from './dashboard/contracts';
import { CHANNELS, STAGES, formatMoney, stageAgeDays } from './dashboard/model';
import { dashboardErrorText, dashboardFixtureSource, dashboardReviewSource } from './dashboard/source';
import { OfficeIcon } from './OfficeIcon';
import { DashboardShell, ApprovedDashboardSummary, type Section } from './dashboard/ApprovedDashboardLayout';
import { PersistedQuoteSection } from './dashboard/PersistedQuoteSection';
import type { DashboardQuoteAccessSource } from './dashboard/quote-access';
import type { EventQuoteClient } from './event-quote-client';
import { EventWorkspace } from './dashboard/EventWorkspace';
import type { EventWorkflowTab } from './dashboard/event-workflow';

const VIEW_LIFETIME_MS = 15 * 60 * 1000;
const STAGE_ORDER: Stage[] = ['new', 'qualifying', 'proposal', 'confirmed'];
const CHANNEL_ORDER: Channel[] = ['email', 'web', 'instagram', 'messenger'];
const COVERAGE = { complete: 'Completa', partial: 'Parcial', unknown: 'Desconocida' };
const date = (value: string | null, full = false) => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Sin fecha verificada';
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium', ...(full ? { timeStyle: 'short' as const } : {}), timeZone: 'UTC' }).format(new Date(value)) + (full ? ' UTC' : '');
};

// Every read has an identity as well as an AbortSignal. A source that ignores
// cancellation must still be unable to restore a withdrawn or superseded view.
export class DashboardReadGate {
  private generation = 0;
  private controller: AbortController | null = null;
  start() {
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return { signal: controller.signal, current: () => this.generation === generation && !controller.signal.aborted };
  }
  cancel() { this.generation += 1; this.controller?.abort(); this.controller = null; }
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="gd-empty"><span className="gd-empty-mark" aria-hidden="true">○</span><h3>{title}</h3><p>{children}</p></div>;
}
function Label({ children }: { children: React.ReactNode }) { return <span className="gd-label">{children}</span>; }
export function DashboardKanban({ snapshot }: { snapshot: DashboardSnapshot }) {
  return <div className="gd-kanban" aria-label="Oportunidades por etapa, solo lectura">{STAGE_ORDER.map((stage, index) => {
    const opportunities = snapshot.opportunities.filter(item => item.stage === stage);
    return <section className={`gd-stage gd-stage-${stage}`} aria-labelledby={`gd-stage-${stage}`} key={stage}>
      <header><div><span className="gd-stage-dot" aria-hidden="true" /><h3 id={`gd-stage-${stage}`}>{STAGES[stage]}</h3></div><span className="gd-stage-count">{opportunities.length}</span></header>
      <p className="gd-stage-step">0{index + 1} <span>Etapa del ejemplo</span></p>
      <div className="gd-stage-items">{opportunities.length ? opportunities.map(item => {
        const age = stageAgeDays(item, snapshot.asOf);
        return <article className="gd-opportunity" key={item.id} data-testid="dashboard-opportunity">
          <span className="gd-channel-label">{CHANNELS[item.channel]}</span><h4>{item.name}</h4><p>{item.event}</p>
          <dl><div><dt>Evento</dt><dd>{date(item.eventDate)}</dd></div><div><dt>Personas</dt><dd>{item.guests ?? '—'}</dd></div></dl>
          <footer><span>{item.amountMinor !== null && item.currency ? formatMoney(item.amountMinor, item.currency) : 'Importe sin verificar'}</span><small>{age === null ? 'Antigüedad sin verificar' : `${age} ${age === 1 ? 'día' : 'días'} en etapa`}</small></footer>
        </article>;
      }) : <p className="gd-stage-empty">Sin oportunidades en esta etapa del ejemplo.</p>}</div>
    </section>;
  })}</div>;
}

const CONVERSATION_STATE: Record<Conversation['state'], string> = { needs_review: 'Por revisar', unread: 'Sin leer', waiting: 'En espera' };
export function DashboardInbox({ snapshot }: { snapshot: DashboardSnapshot }) {
  const [channel, setChannel] = useState<Channel>('email');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const conversations = snapshot.conversations.filter(item => item.channel === channel);
  const selected = conversations.find(item => item.id === selectedId) ?? conversations[0] ?? null;
  const sourceId = channel === 'email' ? 'gmail' : channel;
  const configured = snapshot.sources.some(source => source.id === sourceId && source.mode !== 'unconfigured');
  return <div className="gd-inbox">
    <div className="gd-channel-filters" aria-label="Filtrar conversaciones por canal">{CHANNEL_ORDER.map(item => <button key={item} type="button" aria-pressed={channel === item} onClick={() => { setChannel(item); setSelectedId(null); }}><span>{CHANNELS[item]}</span><span className="gd-filter-count" aria-label={snapshot.conversations.some(conversation => conversation.channel === item) ? "Conversaciones de ejemplo" : "Sin datos del canal"}>{snapshot.conversations.some(conversation => conversation.channel === item) ? snapshot.conversations.filter(conversation => conversation.channel === item).length : "—"}</span></button>)}</div>
    <div className="gd-inbox-source"><span className="gd-hollow-dot" aria-hidden="true" />{configured ? 'Cobertura limitada a la muestra local.' : `${CHANNELS[channel]} sin configurar como fuente real.`} Los mensajes de ejemplo no acreditan una conexión.</div>
    {conversations.length ? <div className="gd-inbox-grid"><div className="gd-conversation-list" aria-label={`Conversaciones de ${CHANNELS[channel]}`}><div className="gd-list-caption">{conversations.length} conversaciones de ejemplo</div>{conversations.map(conversation => <button key={conversation.id} type="button" className={`gd-conversation ${selected?.id === conversation.id ? 'is-selected' : ''}`} aria-pressed={selected?.id === conversation.id} onClick={() => setSelectedId(conversation.id)}>
      <span className="gd-avatar" aria-hidden="true">{conversation.contact.split(' ').map(word => word[0]).slice(0, 2).join('')}</span><span className="gd-conversation-info"><span className="gd-conversation-title">{conversation.contact}</span><span className="gd-conversation-subject">{conversation.subject || 'Sin asunto'}</span><span className="gd-conversation-state">{CONVERSATION_STATE[conversation.state]}</span></span><span className="gd-conversation-date">{date(conversation.at)}</span>
    </button>)}</div><article className="gd-conversation-detail" aria-label="Detalle de la conversación" aria-live="polite">{selected && <><Label>Mensaje de ejemplo · {CHANNELS[selected.channel]}</Label><h3>{selected.subject || 'Sin asunto'}</h3><div className="gd-detail-sender"><span className="gd-avatar" aria-hidden="true">{selected.contact.slice(0, 1)}</span><div><strong>{selected.contact}</strong><span>{selected.mailbox ? `Buzón: ${selected.mailbox}` : 'Sin buzón verificado'}</span></div><time dateTime={selected.at}>{date(selected.at, true)}</time></div><p className="gd-message-body">{selected.bodyText}</p><section className="gd-draft-context" aria-label="Contexto de revisión de respuesta"><div><Label>Revisión de respuesta</Label><span className="gd-pill">Sin vinculación verificada</span></div><h4>Revisa el borrador exacto</h4><p>Esta vista no vincula automáticamente el mensaje con un borrador. Verifica buzón, destinatario, fuentes y contenido en Comunicaciones.</p><a className="gd-button gd-button-dark gd-review-cta" href="/office/communications">Revisar en Comunicaciones <span aria-hidden="true">↗</span></a></section><div className="gd-detail-footer"><span>Lectura local. Seleccionar no marca como leído.</span></div></>}</article></div>
      : <Empty title={configured ? 'Sin conversaciones en la muestra' : `${CHANNELS[channel]} pendiente de conexión`}>{configured ? 'Esta muestra no contiene mensajes de este canal. No indica que tu bandeja real esté vacía.' : 'No hay mensajes de ejemplo para este canal. La bandeja real no se ha consultado.'}</Empty>}
  </div>;
}

export function DashboardSources({ snapshot }: { snapshot: DashboardSnapshot }) {
  return <div className="gd-source-grid">{snapshot.sources.map(source => <article className="gd-source-card" key={source.id}><header><span className="gd-source-symbol" aria-hidden="true">{source.mode === 'fixture' ? 'G' : '○'}</span><span className={`gd-pill ${source.mode === 'fixture' ? 'gd-pill-green' : ''}`}>{source.mode === 'fixture' ? 'Muestra local' : 'Sin configurar'}</span></header><h3>{source.label}</h3><p>{source.note}</p><dl><div><dt>Cobertura</dt><dd>{COVERAGE[source.coverage]}</dd></div><div><dt>{source.mode === 'fixture' ? 'Corte de la muestra' : 'Última verificación'}</dt><dd>{source.lastVerifiedAt ? date(source.lastVerifiedAt, true) : 'Sin verificación'}</dd></div></dl></article>)}</div>;
}

export function DashboardReviewPanel({ queue, busy, error, notice, onRead }: { queue: ApprovalQueue | null; busy: boolean; error: string | null; notice: string | null; onRead: () => void }) {
  const visibleQueue = busy || error || notice ? null : queue;
  const states = { needs_review: 'Necesita revisión', blocked: 'Bloqueado', approved_unsent: 'Aprobado en la muestra · no enviado' };
  return <section className="gd-panel gd-review" aria-labelledby="gd-review-title"><div className="gd-panel-heading"><div><Label>Control humano</Label><h2 id="gd-review-title">Pendientes de revisión</h2></div><span className="gd-outline-icon"><OfficeIcon name="approval" size={19} /></span></div>
    <p className="gd-panel-intro">Consulta la cola local y revisa cada borrador exacto en Comunicaciones. El dashboard no aprueba ni envía mensajes.</p>
    <button className="gd-button gd-button-dark" type="button" onClick={onRead} disabled={busy} data-testid="dashboard-read-reviews">{busy ? 'Consultando…' : visibleQueue ? 'Volver a consultar la cola' : 'Consultar cola de revisión'}<OfficeIcon name="chevron" size={15} /></button>
    {error && <p className="gd-inline-error" role="alert">{error}</p>}{notice && <p className="gd-muted" role="status">{notice}</p>}
    {visibleQueue ? <><p className="gd-review-caption">Muestra sintética · Revisión {visibleQueue.workflowRevision} · Vence {date(visibleQueue.expiresAt, true)}</p>{visibleQueue.items.length ? <ul className="gd-review-list">{visibleQueue.items.map(item => <li key={`${item.id}-${item.revision}`}><span className="gd-review-dot" aria-hidden="true" /><div><strong>{item.subject || 'Sin asunto'}</strong><p>{item.recipient} · Buzón {item.mailbox}</p><span>{states[item.state]} · {item.reason}</span><p className="gd-review-revision">Revisión del borrador: {item.revision}</p></div><a href="/office/communications" aria-label={`Revisar en Comunicaciones: ${item.subject || 'Sin asunto'}`}>Revisar <span aria-hidden="true">↗</span></a></li>)}</ul> : <p className="gd-muted gd-review-caption">Sin pendientes en esta cola sintética consultada.</p>}<p className="gd-review-footnote">Abre Comunicaciones y selecciona el borrador; verifica allí destinatario, texto, fuentes y versión antes de autorizar. Este enlace no conserva una selección ni una aprobación.</p></>
      : !busy && !error && !notice && <p className="gd-review-caption">Aún no consultada. No se inicia ninguna sesión automáticamente.</p>}
  </section>;
}


export const DASHBOARD_SECTIONS: Section[] = ['summary', 'opportunities', 'inbox', 'quotes', 'events', 'calendar', 'tastings', 'logistics', 'payments', 'suppliers', 'followups', 'knowledge', 'sources', 'reviews', 'communications'];
export function sectionFromHash(hash: string): Section | null {
  const key = hash.replace(/^#/, '').split('/')[0];
  if (!key) return 'summary';
  return DASHBOARD_SECTIONS.includes(key as Section) ? key as Section : null;
}
const EVENT_TABS: Partial<Record<Section, EventWorkflowTab>> = { events: 'consulta', quotes: 'cotizacion', payments: 'cobro', calendar: 'operaciones', tastings: 'tastings', logistics: 'operaciones', suppliers: 'operaciones' };
function sectionForEventTab(tab: EventWorkflowTab): Section { return ({ consulta: 'events', brief: 'events', cotizacion: 'quotes', revision: 'quotes', cobro: 'payments', operaciones: 'calendar', tastings: 'tastings' } as const)[tab]; }
const DEMO_PROPOSAL_ARTIFACT = { href: new URL('./assets/demo/DEMO-EVT-042-propuesta-v2.pdf', import.meta.url).pathname, fileName: 'DEMO-EVT-042-propuesta-v2.pdf', sha256: '370eaa2e3668c3836e6e7c496b47b57b75d000682f260ffce868e803df57e630', byteLength: 12697, previewHref: new URL('./assets/demo/DEMO-EVT-042-propuesta-v2-page-1.png', import.meta.url).pathname, previewSha256: '76aff590db6ca01d91a1053f32612a6f9d6678dfa52ba8e814500336b9d885a0', previewByteLength: 178239 };
const TITLES: Partial<Record<Section, [string, string]>> = {
  summary: ['Dashboard', 'Todo el negocio, en una sola vista.'], opportunities: ['Oportunidades', 'Etapas de la muestra comercial. Solo lectura.'], inbox: ['Bandeja', 'Cada canal y buzón conserva su identidad.'], reviews: ['Revisión local', 'Consulta explícita y revisión exacta en Comunicaciones.'],
  sources: ['Fuentes', 'Origen, cobertura y última verificación.'], events: ['Eventos', 'Un expediente para consulta, propuesta y operación.'], quotes: ['Propuestas', 'Versiones, contenido exacto y revisión humana.'], payments: ['Enlaces de pago', 'Preparación, simulación y verificación de cobro separadas.'], calendar: ['Calendario', 'Fechas propuestas y reservas pendientes de verificar.'], tastings: ['Tastings', 'Coordinación Regus por ciudad y zona.'], logistics: ['Logística', 'Preparación del mismo evento y dependencias pendientes.'], suppliers: ['Proveedores', 'Candidato, disponibilidad, aceptación y asignación son distintos.'], followups: ['Seguimientos', 'Pendientes del expediente, sin envíos automáticos.'], knowledge: ['Conocimiento', 'Reglas y fuentes que limitan cada borrador.'],
};

export type DashboardEventMode = 'saved' | 'demo';
export function eventModeFromHash(hash: string): DashboardEventMode {
  const [section, tab] = hash.replace(/^#/, '').split('/');
  return EVENT_TABS[section as Section] && ['consulta', 'brief', 'cotizacion', 'revision', 'cobro', 'operaciones', 'tastings'].includes(tab) ? 'demo' : 'saved';
}
export type DashboardPageProps = { quoteAccessSource?: DashboardQuoteAccessSource; quoteClient?: EventQuoteClient; initialEventMode?: DashboardEventMode; source?: DashboardReadSource; reviewSource?: DashboardReviewSource; initialSnapshot?: DashboardSnapshot; initialSection?: Section; initialVisualDemo?: boolean };
export function DashboardPage({ quoteAccessSource, quoteClient, initialEventMode = 'saved', source = dashboardFixtureSource, reviewSource = dashboardReviewSource, initialSnapshot, initialSection = 'summary', initialVisualDemo = false }: DashboardPageProps) {
  const [section, setSection] = useState<Section>(initialSection);
  const [eventMode, setEventMode] = useState<DashboardEventMode>(initialEventMode);
  const [hasOpenedDemo, setHasOpenedDemo] = useState(initialEventMode === 'demo');
  const [quoteNavigationEpoch, setQuoteNavigationEpoch] = useState(0);
  const [eventSessionEpoch, setEventSessionEpoch] = useState(0);
  const [focusHeadingOnSectionChange, setFocusHeadingOnSectionChange] = useState(true);
  const [visualDemo, setVisualDemo] = useState(initialVisualDemo);
  const [activeEventTab, setActiveEventTab] = useState<EventWorkflowTab>(EVENT_TABS[initialSection] ?? 'consulta');
  const navigateSection = (next: Section) => {
    if (!DASHBOARD_SECTIONS.includes(next)) return;
    setQuoteNavigationEpoch(epoch => epoch + 1);
    if (next === 'quotes' || next === 'events') setEventMode('saved');
    setFocusHeadingOnSectionChange(true); setSection(next);
    if (EVENT_TABS[next]) setActiveEventTab(EVENT_TABS[next]!);
    if (typeof window !== 'undefined' && window.location.hash !== `#${next}`) window.history.pushState(null, '', `#${next}`);
  };
  useEffect(() => {
    const sync = () => { const next = sectionFromHash(window.location.hash); if (next) { setQuoteNavigationEpoch(epoch => epoch + 1); const mode = eventModeFromHash(window.location.hash); setEventMode(mode); if (mode === 'demo') setHasOpenedDemo(true); setFocusHeadingOnSectionChange(true); setSection(next); const tab = window.location.hash.split('/')[1]; if (['consulta', 'brief', 'cotizacion', 'revision', 'cobro', 'operaciones', 'tastings'].includes(tab)) setActiveEventTab(tab as EventWorkflowTab); else if (EVENT_TABS[next]) setActiveEventTab(EVENT_TABS[next]!); } };
    sync(); window.addEventListener('popstate', sync); window.addEventListener('hashchange', sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('hashchange', sync); };
  }, []);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(initialSnapshot ?? null);
  const [receivedAt, setReceivedAt] = useState<number | null>(initialSnapshot ? Date.now() : null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'paused' | 'error'>(initialSnapshot ? 'ready' : 'loading');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [queue, setQueue] = useState<ApprovalQueue | null>(null);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const snapshotGate = useRef(new DashboardReadGate());
  const queueGate = useRef(new DashboardReadGate());
  const mounted = useRef(false);
  const clearQueue = useCallback(() => { queueGate.current.cancel(); setQueue(null); setQueueBusy(false); setQueueError(null); setQueueNotice(null); }, []);
  const withdraw = useCallback((reason: string) => {
    setEventSessionEpoch(epoch => epoch + 1); snapshotGate.current.cancel(); clearQueue(); setSnapshot(null); setReceivedAt(null); setPhase('paused'); setError(null); setNotice(reason);
  }, [clearQueue]);
  const load = useCallback(async () => {
    setEventSessionEpoch(epoch => epoch + 1); clearQueue(); const request = snapshotGate.current.start(); setSnapshot(null); setReceivedAt(null); setPhase('loading'); setError(null); setNotice(null);
    try { const result = await source.read(request.signal); if (!mounted.current || !request.current()) return; setSnapshot(result); setReceivedAt(Date.now()); setPhase('ready'); }
    catch (failure) { if (!mounted.current || !request.current()) return; clearQueue(); setSnapshot(null); setPhase('error'); setError(dashboardErrorText(failure)); }
  }, [source, clearQueue]);
  const readQueue = useCallback(async () => {
    const request = queueGate.current.start(); setQueue(null); setQueueBusy(true); setQueueError(null); setQueueNotice(null);
    try { const result = await reviewSource.read(request.signal); if (!mounted.current || !request.current()) return;
      const expires = Date.parse(result.expiresAt); if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('La cola consultada ya venció. Vuelve a consultarla explícitamente.');
      setQueue({ ...result, expiresAt: new Date(Math.min(expires, Date.now() + VIEW_LIFETIME_MS)).toISOString() });
    } catch (failure) { if (mounted.current && request.current()) { setQueue(null); setQueueError(dashboardErrorText(failure)); } }
    finally { if (mounted.current && request.current()) setQueueBusy(false); }
  }, [reviewSource]);
  useEffect(() => { clearQueue(); }, [reviewSource, clearQueue]);
  useEffect(() => { mounted.current = true; if (!initialSnapshot) void load(); return () => { mounted.current = false; snapshotGate.current.cancel(); queueGate.current.cancel(); }; }, [load, initialSnapshot]);
  useEffect(() => {
    const hide = () => withdraw('La vista se retiró al salir de la página. Vuelve a cargar la muestra para continuar.');
    const visibility = () => { if (document.visibilityState === 'hidden') hide(); };
    document.addEventListener('visibilitychange', visibility); window.addEventListener('pagehide', hide); visibility();
    return () => { document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', hide); };
  }, [withdraw]);
  useEffect(() => { if (receivedAt === null) return; const timer = window.setTimeout(() => withdraw('La vista venció después de 15 minutos. Vuelve a cargar la muestra; la cola requiere una consulta nueva.'), Math.max(0, receivedAt + VIEW_LIFETIME_MS - Date.now())); return () => window.clearTimeout(timer); }, [receivedAt, withdraw]);
  useEffect(() => { if (!queue) return; const timer = window.setTimeout(() => { clearQueue(); setQueueNotice('La consulta venció. Vuelve a consultar la cola para ver el estado actual.'); }, Math.max(0, Date.parse(queue.expiresAt) - Date.now())); return () => window.clearTimeout(timer); }, [queue, clearQueue]);
  const eventTab = EVENT_TABS[section];
  const showSavedQuotes = eventMode === 'saved' && (section === 'quotes' || section === 'events');
  const chooseEventMode = (mode: DashboardEventMode) => {
    setQuoteNavigationEpoch(epoch => epoch + 1); setEventMode(mode);
    if (mode === 'demo') setHasOpenedDemo(true);
    const next = mode === 'saved' && section !== 'quotes' && section !== 'events' ? 'events' : section;
    if (next !== section) { setSection(next); setActiveEventTab('consulta'); }
    const hash = mode === 'demo' ? `#${next}/${activeEventTab}` : `#${next}`;
    if (typeof window !== 'undefined' && window.location.hash !== hash) window.history.pushState(null, '', hash);
  };
  const title = TITLES[section] ?? ['Dashboard', 'Todo el negocio, en una sola vista.'];
  const review = <DashboardReviewPanel queue={queue} busy={queueBusy} error={queueError} notice={queueNotice} onRead={() => void readQueue()} />;
  const context = <details className="ga-read-status"><summary>{showSavedQuotes ? 'Muestra del dashboard · Corte y cobertura' : 'Datos sintéticos · Corte y cobertura'}</summary><div data-testid="dashboard-provenance"><span>Fuente: muestra local sintética</span><span>Corte: {snapshot ? date(snapshot.asOf, true) : 'Sin consulta vigente'}</span><span>Cobertura: {snapshot ? 'parcial; datos reales desconocidos' : 'sin verificar'}</span><span>0 envíos · sin conexión a proveedores</span></div></details>;
  return <DashboardShell focusHeadingOnSectionChange={focusHeadingOnSectionChange} section={section} onNavigate={navigateSection} title={title[0]} subtitle={title[1]} visualDemo={section === 'summary' && visualDemo} enabledSections={DASHBOARD_SECTIONS} actions={<div className="ga-local-actions">
    {section === 'summary' && <button type="button" aria-pressed={visualDemo} onClick={() => setVisualDemo(value => !value)} data-testid="dashboard-visual-mode">{visualDemo ? 'Ver datos fuente' : 'Vista DEMO'}</button>}
    <button type="button" onClick={() => void load()} disabled={phase === 'loading'} data-testid="dashboard-refresh">{phase === 'loading' ? 'Cargando…' : snapshot ? 'Actualizar muestra' : 'Cargar muestra'}</button>
  </div>}>
    <div className="gourmet-dashboard gd-module-status">{error && <div className="gd-error" role="alert"><strong>No se pudo cargar la vista.</strong><p>{error}</p><p>Se retiraron los datos y la cola anterior. Vuelve a cargar cuando quieras intentarlo.</p></div>}{notice && <div className="gd-notice" role="status">{notice}</div>}{phase === 'loading' && <div className="gd-loading" role="status"><h2>Preparando tu vista</h2><p>Leyendo la muestra local, sin consultar proveedores.</p></div>}</div>
    {eventTab !== undefined && <div className="gourmet-event-workspace"><div className="gew-actions" aria-label="Origen del expediente">
      <button type="button" className="gew-button" aria-pressed={eventMode === 'saved'} data-testid="dashboard-quotes-saved" onClick={() => chooseEventMode('saved')}>Guardadas</button>
      <button type="button" className="gew-button" aria-pressed={eventMode === 'demo'} data-testid="dashboard-quotes-demo" onClick={() => chooseEventMode('demo')}>Ejemplo DEMO</button>
    </div></div>}
    {showSavedQuotes && <PersistedQuoteSection key={`${eventSessionEpoch}-${quoteNavigationEpoch}-${section}`} source={quoteAccessSource} client={quoteClient} />}
    {eventTab !== undefined && eventMode === 'saved' && !showSavedQuotes && <div className="gourmet-event-workspace"><p className="gew-notice">Esta operación solo está disponible como ejemplo. Selecciona Ejemplo DEMO para abrir la simulación.</p></div>}
    {snapshot && <>
      {section === 'summary' && <ApprovedDashboardSummary visualDemo={visualDemo} sampleOpportunityCount={snapshot.opportunities.length} onOpenInbox={() => navigateSection('inbox')} />}
      <div className="gourmet-dashboard gd-approved-module">
        {section === 'opportunities' && <><div className="gd-section-toolbar"><p><strong>{snapshot.opportunities.length}</strong> oportunidades de ejemplo</p><button className="gd-button gd-button-light" type="button" onClick={() => { navigateSection('quotes'); setEventMode('demo'); setHasOpenedDemo(true); if (typeof window !== 'undefined') window.history.replaceState(null, '', '#quotes/cotizacion'); }}>Abrir expediente DEMO-EVT-042</button></div><DashboardKanban snapshot={snapshot} /><p className="gd-section-note">Las tarjetas son una muestra independiente. No se asocian al expediente DEMO-EVT-042 por coincidencia de nombre; no prueban ventas ni pagos reales.</p></>}
        {section === 'inbox' && <DashboardInbox snapshot={snapshot} />}
        {section === 'reviews' && review}
        {section === 'sources' && <><DashboardSources snapshot={snapshot} /><div className="gd-source-disclosure"><h2>Cobertura y límites</h2><p>El corte corresponde únicamente a esta muestra local sintética y parcial, no a una sincronización del negocio. Los datos reales son desconocidos: no se consulta ningún proveedor ni se realizan envíos.</p><p>Una fuente pendiente no equivale a cero actividad. Ingresos, conversión, gasto publicitario y disponibilidad real permanecen sin verificar. La vista DEMO muestra un escenario visual independiente; no sustituye estas lecturas ni la cola local de revisión.</p><p>Las lecturas y el expediente temporal caducan a los 15 minutos y se retiran al ocultar o salir de la página. Para volver, pulsa Cargar muestra. La cola requiere una consulta explícita por separado.</p><p>Periodo de la muestra: {date(snapshot.periodStart)} – {date(snapshot.asOf)} · Horas en UTC.</p></div></>}
        {section === 'knowledge' && <section className="gd-panel"><h2>Reglas de Gourmet</h2><p className="gd-panel-intro">Reglas representadas en el escenario local; no son una configuración publicada de agentes.</p><ul className="gd-rules"><li>No inventar precios, fechas, disponibilidad ni promesas.</li><li>Cada borrador requiere aprobación exacta de cuenta, destinatarios, contenido, adjuntos y contexto.</li><li>Un enlace preparado no equivale a generado, compartido ni pagado.</li><li>Reuniones y tastings en Regus de la ciudad/zona; centro, sala, coste, permiso de alimentos y reserva se verifican por separado.</li><li>El cierre humano habilita sourcing; un candidato a chef no es un proveedor aceptado.</li><li>Catálogo y precios reales pendientes de una fuente autorizada.</li></ul></section>}
        {section === 'followups' && <section className="gd-panel"><h2>Seguimientos del expediente</h2><p className="gd-panel-intro">Plan representado, sin programación ni envíos. Cada mensaje se prepara y aprueba por separado.</p><ul className="gd-rules"><li>Confirmar fecha, lugar y restricciones del evento.</li><li>Revisar propuesta v2 y adjunto después del cambio de 20 a 24 invitados.</li><li>Verificar el estado de cobro si la consulta falla; no cobrar ni enviar otra vez por un timeout.</li><li>Coordinar centro Regus y permiso de alimentos antes de confirmar el tasting.</li></ul><button className="gd-button gd-button-dark" type="button" onClick={() => { navigateSection('events'); setEventMode('demo'); setHasOpenedDemo(true); if (typeof window !== 'undefined') window.history.replaceState(null, '', '#events/consulta'); }}>Abrir expediente DEMO</button></section>}
      </div>
      {hasOpenedDemo && <EventWorkspace key={eventSessionEpoch} visible={eventTab !== undefined && eventMode === 'demo'} activeTab={activeEventTab} onTabChange={tab => { setFocusHeadingOnSectionChange(false); const next = sectionForEventTab(tab); setActiveEventTab(tab); setSection(next); if (typeof window !== 'undefined' && window.location.hash !== `#${next}/${tab}`) window.history.pushState(null, '', `#${next}/${tab}`); }} proposalArtifact={DEMO_PROPOSAL_ARTIFACT} />}
    </>}
    {context}
  </DashboardShell>;
}
