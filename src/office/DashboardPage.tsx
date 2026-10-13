import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalQueue, Channel, Conversation, DashboardReadSource, DashboardReviewSource, DashboardSnapshot, Metric, Stage } from './dashboard/contracts';
import { CHANNELS, STAGES, dashboardMetrics, formatMoney, stageAgeDays } from './dashboard/model';
import { dashboardErrorText, dashboardFixtureSource, dashboardReviewSource } from './dashboard/source';
import { OfficeIcon, type OfficeIconName } from './OfficeIcon';

const VIEW_LIFETIME_MS = 15 * 60 * 1000;
const STAGE_ORDER: Stage[] = ['new', 'qualifying', 'proposal', 'confirmed'];
const CHANNEL_ORDER: Channel[] = ['email', 'web', 'instagram', 'messenger'];
const COVERAGE = { complete: 'Completa', partial: 'Parcial', unknown: 'Desconocida' };
type Section = 'summary' | 'opportunities' | 'inbox' | 'sources';
const SECTIONS: { id: Section; label: string; icon: OfficeIconName }[] = [
  { id: 'summary', label: 'Resumen', icon: 'dashboard' },
  { id: 'opportunities', label: 'Oportunidades', icon: 'list' },
  { id: 'inbox', label: 'Bandeja', icon: 'file' },
  { id: 'sources', label: 'Fuentes', icon: 'settings' },
];
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
function MetricCard({ metric }: { metric: Metric }) {
  const value = metric.value === null ? '—' : metric.unit === 'money' && metric.currency ? formatMoney(metric.value, metric.currency) : `${metric.value}${metric.unit === 'percent' ? '%' : ''}`;
  return <article className={`gd-metric gd-metric-${metric.id}`} data-testid={`dashboard-metric-${metric.id}`}>
    <div className="gd-metric-heading"><h2>{metric.label}</h2><span aria-hidden="true">{metric.value === null ? '−' : '○'}</span></div>
    <strong className="gd-metric-value">{value}</strong>
    <p>{metric.note}</p><span className="gd-metric-coverage">Cobertura: {COVERAGE[metric.coverage].toLowerCase()}</span>
  </article>;
}

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
    </button>)}</div><article className="gd-conversation-detail" aria-label="Detalle de la conversación" aria-live="polite">{selected && <><Label>Mensaje de ejemplo · {CHANNELS[selected.channel]}</Label><h3>{selected.subject || 'Sin asunto'}</h3><div className="gd-detail-sender"><span className="gd-avatar" aria-hidden="true">{selected.contact.slice(0, 1)}</span><div><strong>{selected.contact}</strong><span>{selected.mailbox ? `Buzón: ${selected.mailbox}` : 'Sin buzón verificado'}</span></div><time dateTime={selected.at}>{date(selected.at, true)}</time></div><p className="gd-message-body">{selected.bodyText}</p><section className="gd-draft-context" aria-label="Contexto de revisión de respuesta"><div><Label>Revisión de respuesta</Label><span className="gd-pill">Borrador sin verificar</span></div><h4>Antes de autorizar</h4><p>Esta vista no vincula automáticamente el mensaje con un borrador. En Comunicaciones, selecciona y verifica el buzón, el destinatario, las fuentes y el contenido antes de autorizar.</p></section><div className="gd-detail-footer"><span>Lectura local. Seleccionar no marca como leído.</span><a href="/office/communications">Ir a Comunicaciones <span aria-hidden="true">↗</span></a></div></>}</article></div>
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

function Summary({ snapshot, onSection, review }: { snapshot: DashboardSnapshot; onSection: (section: Section) => void; review: React.ReactNode }) {
  const metrics = dashboardMetrics(snapshot).filter(item => ['opportunities', 'pipeline', 'conversion'].includes(item.id));
  return <><div className="gd-metrics">{metrics.map(metric => <MetricCard metric={metric} key={metric.id} />)}</div>
    <section className="gd-ads-panel" aria-labelledby="gd-ads-title"><div className="gd-ads-heading"><h2 id="gd-ads-title">Publicidad</h2><span className="gd-pill">Sin configurar</span></div><div className="gd-ads-stats"><div><span>Inversión publicitaria</span><strong>—</strong><small>Sin cuenta ni periodo verificados</small></div><div><span>Consultas atribuidas</span><strong>—</strong><small>Sin atribución verificada</small></div><div><span>Retorno publicitario</span><strong>—</strong><small>Sin gasto ni ingresos verificados</small></div></div></section>
    <section className="gd-panel gd-revenue" aria-labelledby="gd-revenue-title" data-testid="dashboard-revenue-history"><div className="gd-panel-heading"><div><Label>Evolución mensual</Label><h2 id="gd-revenue-title">Ingresos cobrados</h2></div><span className="gd-pill">Pagos pendientes de conectar</span></div><div className="gd-revenue-empty"><div className="gd-revenue-lines" aria-hidden="true"><span /><span /><span /></div><div className="gd-revenue-message"><strong data-testid="dashboard-revenue-unknown">—</strong><h3>Ingresos reales sin verificar</h3><p>La evolución mensual aparecerá cuando exista una fuente de pagos verificada.</p></div></div><div className="gd-panel-bottom"><span>Fuente: pagos sin conectar · Cobertura desconocida</span><span>Una oportunidad confirmada no acredita un cobro.</span></div></section>
    <div className="gd-summary-grid">{review}<section className="gd-panel gd-activity"><div className="gd-panel-heading"><div><Label>Actividad del ejemplo</Label><h2>Actividad reciente</h2></div><OfficeIcon name="history" size={19} /></div>{snapshot.activity.length ? <ol>{snapshot.activity.slice(0, 4).map(item => <li key={item.id}><span className={`gd-activity-icon gd-activity-${item.kind}`}><OfficeIcon name={item.kind === 'review' ? 'approval' : item.kind === 'proposal' ? 'file' : 'plus'} size={15} /></span><div><p>{item.label}</p><time dateTime={item.at}>{date(item.at, true)}</time></div></li>)}</ol> : <p className="gd-muted">Sin actividad en esta muestra.</p>}<p className="gd-activity-note">Registro sintético. No es actividad en tiempo real.</p></section></div>
    <section className="gd-panel gd-pending gd-pending-wide"><div><Label>Por conectar</Label><h2>Áreas pendientes</h2><p className="gd-panel-intro">Estas áreas necesitan fuentes verificadas antes de mostrar resultados.</p></div><ul><li><OfficeIcon name="file" size={18} /><div><strong>Catálogo</strong><span>Productos, menús y precios</span></div><span className="gd-pill">Pendiente</span></li><li><OfficeIcon name="analytics" size={18} /><div><strong>Pagos</strong><span>Ingresos y gasto real: —</span></div><span className="gd-pill">Pendiente</span></li><li><OfficeIcon name="calendar" size={18} /><div><strong>Calendario</strong><span>Disponibilidad sin verificar</span></div><span className="gd-pill">Pendiente</span></li></ul><button className="gd-text-button" type="button" onClick={() => onSection('sources')}>Ver cobertura de las fuentes <span aria-hidden="true">↗</span></button></section>
  </>;
}

export type DashboardPageProps = { source?: DashboardReadSource; reviewSource?: DashboardReviewSource; initialSnapshot?: DashboardSnapshot; initialSection?: Section };
export function DashboardPage({ source = dashboardFixtureSource, reviewSource = dashboardReviewSource, initialSnapshot, initialSection = 'summary' }: DashboardPageProps) {
  const [section, setSection] = useState<Section>(initialSection);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusAfterNavigation = useRef(false);
  const navigateSection = (next: Section) => { focusAfterNavigation.current = true; setSection(next); };
  useEffect(() => { if (focusAfterNavigation.current) { focusAfterNavigation.current = false; headingRef.current?.focus(); } }, [section]);
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
    snapshotGate.current.cancel(); clearQueue(); setSnapshot(null); setReceivedAt(null); setPhase('paused'); setError(null); setNotice(reason);
  }, [clearQueue]);
  const load = useCallback(async () => {
    clearQueue(); const request = snapshotGate.current.start(); setSnapshot(null); setReceivedAt(null); setPhase('loading'); setError(null); setNotice(null);
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
  const titles: Record<Section, [string, string]> = { summary: ['Dashboard', 'Visión general de oportunidades, mensajes y revisión.'], opportunities: ['Oportunidades', 'Etapas de la muestra comercial. Solo lectura, sin mover tarjetas.'], inbox: ['Bandeja', 'Mensajes de ejemplo por canal. Ninguna cuenta real consultada.'], sources: ['Fuentes', 'Origen, cobertura y estado de verificación de cada fuente.'] };
  return <div className="gourmet-dashboard"><a className="gd-skip" href="#gd-main">Saltar al contenido</a><aside className="gd-sidebar"><a className="gd-brand" href="/office/" aria-label="Gourmet, ir a la oficina"><span className="gd-brand-mark" aria-hidden="true">g.</span><span>gourmet<small>ESPACIO DE TRABAJO</small></span></a><div className="gd-workspace-label"><span className="gd-workspace-icon" aria-hidden="true">G</span><span>Gourmet Workspace<small>Vista local de ejemplo</small></span></div><nav aria-label="Navegación del dashboard"><span className="gd-nav-group">VISIÓN GENERAL</span>{SECTIONS.map(item => <button key={item.id} type="button" className="gd-nav-item" aria-current={section === item.id ? 'page' : undefined} onClick={() => setSection(item.id)}><OfficeIcon name={item.icon} size={18} /><span>{item.label}</span>{section === item.id && <span className="gd-nav-selected" aria-hidden="true">•</span>}</button>)}<span className="gd-nav-group">TU OPERACIÓN</span><a className="gd-nav-item" href="/office/"><OfficeIcon name="home" size={18} /><span>Oficina</span><span aria-hidden="true">↗</span></a><a className="gd-nav-item" href="/office/communications"><OfficeIcon name="approval" size={18} /><span>Comunicaciones</span><span aria-hidden="true">↗</span></a><span className="gd-nav-group gd-pending-nav-heading">PRÓXIMAMENTE</span><div className="gd-pending-nav"><span>Catálogo</span><small>Pendiente</small></div><div className="gd-pending-nav"><span>Pagos</span><small>Pendiente</small></div><div className="gd-pending-nav"><span>Calendario</span><small>Pendiente</small></div></nav><div className="gd-sidebar-bottom"><span className="gd-read-only-symbol"><OfficeIcon name="check" size={16} /></span><div><strong>Solo lectura</strong><span>0 acciones externas</span></div></div></aside>
    <div className="gd-workspace"><header className="gd-topbar"><span>Workspace <span aria-hidden="true">/</span> <strong>Dashboard</strong></span><div><span className="gd-pill gd-pill-green">Datos sintéticos</span><span className="gd-topbar-monogram" aria-hidden="true">G</span></div></header><main id="gd-main" className="gd-main" tabIndex={-1}><div className="gd-page-heading"><div><h1 ref={headingRef} tabIndex={-1}>{titles[section][0]}</h1><p>{titles[section][1]}</p></div><button type="button" className="gd-button gd-button-light" onClick={() => void load()} disabled={phase === 'loading'} data-testid="dashboard-refresh"><OfficeIcon name="refresh" size={16} />{phase === 'loading' ? 'Cargando…' : snapshot ? 'Actualizar muestra' : 'Cargar muestra'}</button></div>
      <div className="gd-evidence" data-testid="dashboard-provenance"><div><span className="gd-evidence-dot" aria-hidden="true" /><strong>Fuente:</strong> muestra local sintética</div><div><strong>Corte:</strong> {snapshot ? date(snapshot.asOf, true) : 'Sin consulta vigente'}</div><div><strong>Cobertura:</strong> {snapshot ? 'solo el ejemplo; datos reales desconocidos' : 'sin verificar'}</div><div className="gd-evidence-end">0 envíos · sin conexión a proveedores</div></div>
      {snapshot && <p className="gd-period">Periodo del ejemplo: {date(snapshot.periodStart)} – {date(snapshot.asOf)} · Horas en UTC</p>}
      {error && <div className="gd-error" role="alert"><strong>No se pudo cargar la vista.</strong><p>{error}</p><p>Se retiraron los datos y la cola anterior. Vuelve a cargar cuando quieras intentarlo.</p></div>}
      {notice && <div className="gd-notice" role="status">{notice}</div>}
      {phase === 'loading' && <div className="gd-loading" role="status"><span className="gd-loading-mark" aria-hidden="true">g.</span><h2>Preparando tu vista</h2><p>Leyendo la muestra local, sin consultar proveedores.</p></div>}
      {snapshot && <div className="gd-content" key={section}>{section === 'summary' && <Summary snapshot={snapshot} onSection={navigateSection} review={<DashboardReviewPanel queue={queue} busy={queueBusy} error={queueError} notice={queueNotice} onRead={() => void readQueue()} />} />}{section === 'opportunities' && <><div className="gd-section-toolbar"><p><strong>{snapshot.opportunities.length}</strong> oportunidades de ejemplo</p><span className="gd-pill">Sin arrastrar ni modificar</span></div><DashboardKanban snapshot={snapshot} /><p className="gd-section-note">Todos los contactos, eventos e importes de estas tarjetas son sintéticos. Las etapas no prueban ventas ni pagos reales.</p></>}{section === 'inbox' && <DashboardInbox snapshot={snapshot} />}{section === 'sources' && <><DashboardSources snapshot={snapshot} /><div className="gd-source-disclosure"><h2>Cobertura y límites</h2><p>Una fuente pendiente no equivale a cero actividad. Los ingresos, la conversión, el gasto publicitario y la disponibilidad real permanecen sin verificar. Esta vista no consulta cuentas ni activa agentes.</p><p>Las lecturas caducan a los 15 minutos y se retiran al ocultar o salir de la página. Para volver a ver la información, pulsa Cargar muestra. La cola siempre se consulta por separado.</p></div></>}</div>}
      <footer className="gd-footer"><span>Gourmet <span aria-hidden="true">·</span> Dashboard</span><span>Ejemplo local · Solo lectura</span></footer>
    </main></div></div>;
}
