import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode } from 'react';
import { endDemoSession, executeDemoCommand, loadDemoSession, loadDemoSnapshot, OfficeReadError, startDemoSession } from './adapter';
import type { DemoSession } from './adapter';
import type { AreaId, Evidence, FunctionId, OfficeApproval, OfficeCase, OfficeCommand, OfficeSnapshot, WorkStatus } from './contracts';
import { STATUS_LABELS } from './contracts';
import { AREAS, areaById } from './areas';
import { FUNCTIONS, functionById } from './functions';
import { callTiming, readyForExecution } from './model';
import { OfficeScene } from './OfficeScene';

type View = 'workspace' | 'history' | 'dashboard';
type CommandInput = Omit<OfficeCommand, 'idempotencyKey'>;
const VIEWS: { id: View; title: string }[] = [{ id: 'workspace', title: 'Espacio de trabajo' }, { id: 'history', title: 'Historial' }, { id: 'dashboard', title: 'Dashboard' }];
const DECISIONS: Record<OfficeApproval['status'], string> = { pending: 'Por aprobar', approved_demo: 'Aprobado DEMO', rejected_demo: 'Rechazado DEMO', cancelled_demo: 'Cancelado DEMO' };
const PAYMENT = { verified: 'Verificado', pending: 'Pendiente', unknown: 'Sin evidencia' };
const SUPPLIER = { accepted: 'Aceptado', pending: 'Pendiente', unknown: 'Sin evidencia' };
const PENDING_KEY = 'gourmet-office-demo-pending-intent-v1';
// Only an unconfirmed synthetic command is retained across reloads. This is
// neither an authenticated session nor a snapshot; PostgreSQL remains authoritative.
function readPendingCommand(): OfficeCommand | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const allowed = ['idempotencyKey', 'caseId', 'functionId', 'action', 'text', 'approvalId', 'revision', 'digest'];
    if (Object.keys(item).some(key => !allowed.includes(key))) return null;
    if (typeof item.idempotencyKey !== 'string' || !/^office-[0-9a-f-]{36}$/.test(item.idempotencyKey)) return null;
    if (!['demo-aurora', 'demo-cedar', 'demo-harbor'].includes(item.caseId as string) || !FUNCTIONS.some(fn => fn.id === item.functionId)) return null;
    if (!['draft', 'chat', 'approve', 'reject', 'cancel', 'revise'].includes(item.action as string)) return null;
    if (item.text !== undefined && (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text))) return null;
    if (['chat', 'revise'].includes(item.action as string) && item.text === undefined) return null;
    if (['approve', 'reject', 'cancel', 'revise'].includes(item.action as string) && (typeof item.approvalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(item.approvalId) || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest))) return null;
    return item as OfficeCommand;
  } catch { return null; }
}
function time(value: string) { return new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)); }
function message(error: unknown) { return error instanceof OfficeReadError ? error.message : 'El servicio no pudo confirmar la operación. Actualiza antes de volver a intentarlo.'; }
function countPending(cases: OfficeCase[]) { return cases.reduce((total, item) => total + item.approvals.filter(approval => approval.status === 'pending').length, 0); }
function Status({ status }: { status: WorkStatus }) { return <span className={`status-chip status-${status}`}><span aria-hidden="true" />{STATUS_LABELS[status]}{status === 'running' ? ' · ilustrativo' : ''}</span>; }
function EvidenceDetails({ evidence }: { evidence: Evidence }) {
  return <details className="evidence"><summary>Ver procedencia <span aria-hidden="true">↗</span></summary><dl><dt>Origen</dt><dd>{evidence.source}</dd><dt>Referencia</dt><dd className="reference">{evidence.reference}</dd><dt>Registro</dt><dd>{time(evidence.at)} UTC</dd><dt>Tipo</dt><dd>{evidence.simulated ? 'Evidencia sintética · DEMO' : 'Evidencia observada'}</dd></dl></details>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) { return <div className="empty-state"><span aria-hidden="true">◇</span><h3>{title}</h3><p>{children}</p></div>; }

function ApprovalCard({ approval, caseId, canWrite, busy, submit }: { approval: OfficeApproval; caseId: string; canWrite: boolean; busy: boolean; submit: (input: CommandInput) => Promise<boolean> }) {
  const [editing, setEditing] = useState<{ revision: number; digest: string; text: string } | null>(null);
  const outdated = editing !== null && (editing.revision !== approval.revision || editing.digest !== approval.digest);
  function decide(action: 'approve' | 'reject' | 'cancel') { return submit({ caseId, functionId: approval.functionId, action, approvalId: approval.id, revision: approval.revision, digest: approval.digest }); }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing || !editing.text.trim() || outdated) return;
    const ok = await submit({ caseId, functionId: approval.functionId, action: 'revise', approvalId: approval.id, revision: editing.revision, digest: editing.digest, text: editing.text.trim() });
    if (ok) setEditing(null);
  }
  return <article className="approval-card" data-testid={`office-approval-${approval.id}`}>
    <div className="card-title-row"><div><p className="eyebrow">REVISIÓN {approval.revision} · DEMO</p><h3>{approval.title}</h3></div><span className={`decision-tag decision-${approval.status}`}>{DECISIONS[approval.status]}</span></div>
    <dl className="approval-target"><div><dt>Cuenta</dt><dd>{approval.account}</dd></div><div><dt>Destinatario</dt><dd>{approval.recipient}</dd></div><div><dt>Canal</dt><dd>{approval.channel} · envío bloqueado</dd></div><div><dt>Adjuntos</dt><dd>{approval.attachments.length ? approval.attachments.join(' · ') : 'Sin adjuntos'}</dd></div></dl>
    <p className="approval-body">{approval.body}</p>
    <div className="digest"><span>Huella de esta revisión</span><code>{approval.digest}</code></div>
    <EvidenceDetails evidence={approval.evidence} />
    <p className="approval-policy">La decisión queda vinculada a este contenido, cuenta, destinatario y adjuntos. Aprobar DEMO registra una decisión; no envía ni confirma pago o proveedor.</p>
    {approval.status === 'pending' && <div className="approval-actions"><button className="button button-primary" disabled={!canWrite || busy || editing !== null} onClick={() => void decide('approve')}>Aprobar revisión {approval.revision}</button><button className="button button-secondary" disabled={!canWrite || busy || editing !== null} onClick={() => void decide('reject')}>Rechazar revisión {approval.revision}</button><button className="button button-quiet" disabled={!canWrite || busy || editing !== null} onClick={() => void decide('cancel')}>Cancelar revisión {approval.revision}</button></div>}
    {!editing && <button className="text-button revision-button" disabled={!canWrite || busy} onClick={() => setEditing({ revision: approval.revision, digest: approval.digest, text: approval.body.replace(/^(?:DEMO — )+/, '') })}>Editar revisión {approval.revision} <span aria-hidden="true">↗</span></button>}
    {editing && <form className="revision-form" onSubmit={save}><label htmlFor={`revision-${approval.id}`}>Nuevo contenido de la revisión</label><textarea id={`revision-${approval.id}`} maxLength={2000} rows={5} required value={editing.text} onChange={event => setEditing({ ...editing, text: event.target.value })} /><p className="form-hint">Guardar abre una nueva revisión pendiente e invalida la decisión de la revisión anterior.</p>{outdated && <p className="inline-alert">La revisión cambió. Cierra la edición y revisa el contenido actualizado.</p>}<div className="form-actions"><button className="button button-primary" disabled={!canWrite || busy || outdated || !editing.text.trim()}>Guardar nueva revisión</button><button type="button" className="button button-quiet" disabled={busy} onClick={() => setEditing(null)}>Cancelar edición</button></div></form>}
  </article>;
}

function CaseFacts({ current }: { current: OfficeCase }) {
  const timing = callTiming(current);
  const ready = readyForExecution(current);
  return <section className="case-facts" aria-label="Dependencias del caso"><div className="section-heading"><p className="eyebrow">CADA ESTADO CON SU EVIDENCIA</p><span className="tiny-tag">SINTÉTICO</span></div><div className="fact-grid"><div><span>Venta humana</span><strong>{current.saleClosed === true ? 'Cerrada · DEMO' : current.saleClosed === false ? 'Abierta · DEMO' : 'Sin evidencia'}</strong></div><div><span>Pago</span><strong>{PAYMENT[current.payment]} · DEMO</strong></div><div><span>Proveedor</span><strong>{SUPPLIER[current.supplier]} · DEMO</strong></div><div><span>Preparación del evento</span><strong>{ready ? 'Dependencias resueltas · DEMO' : 'Dependencias pendientes'}</strong></div></div><p className="dependency-note">Primero, se registra el cierre humano. Después se prepara la búsqueda de chef. Pago y aceptación del proveedor se verifican por separado.</p><div className="contact-fact"><span>Captura → contacto humano</span><strong>{timing.connectedSeconds === null ? 'Sin contacto acreditado' : `${timing.connectedSeconds} s · DEMO`}</strong><small>Intento: {timing.attemptSeconds === null ? 'sin evidencia' : `${timing.attemptSeconds} s · DEMO`}. Objetivo ≤ 30 s; un intento no acredita contacto.</small></div><EvidenceDetails evidence={current.evidence} /></section>;
}

function HistoryView({ snapshot, current }: { snapshot: OfficeSnapshot; current: OfficeCase | null }) {
  const rows = current ? [...current.history].sort((a, b) => b.evidence.at.localeCompare(a.evidence.at)) : [];
  return <section className="wide-panel" aria-labelledby="history-title"><div className="panel-heading"><div><p className="eyebrow">TRAZABILIDAD · DEMO</p><h2 id="history-title">Cada decisión deja contexto.</h2><p>Historial del caso seleccionado. Los registros son sintéticos; no representan actividad con clientes.</p></div><span className="count-badge">{rows.length} registros</span></div>{rows.length ? <ol className="history-list">{rows.map(row => <li key={row.id}><div className="history-dot" aria-hidden="true" /><div className="history-content"><div className="card-title-row"><div><p className="eyebrow">{functionById(row.functionId).name} · {time(row.evidence.at)} UTC</p><h3>{row.title}</h3></div><Status status={row.status} /></div><p>{row.detail}</p><EvidenceDetails evidence={row.evidence} /></div></li>)}</ol> : <Empty title="No hay registros confirmados">Abre una sesión de desarrollo y selecciona un caso para consultar su historial.</Empty>}<p className="source-note">Última lectura confirmada: {time(snapshot.asOf)} UTC. {snapshot.note}</p></section>;
}

function DashboardView({ snapshot }: { snapshot: OfficeSnapshot }) {
  const cases = snapshot.cases;
  const contacts = cases.map(item => ({ item, timing: callTiming(item) })).filter(row => row.timing.connectedSeconds !== null);
  const attempts = cases.filter(item => callTiming(item).attemptSeconds !== null).length;
  const knownSales = cases.filter(item => item.saleClosed !== null).length;
  const closed = cases.filter(item => item.saleClosed === true).length;
  const paid = cases.filter(item => item.payment === 'verified' && item.paymentEvidence).length;
  const supplierAccepted = cases.filter(item => item.supplier === 'accepted' && item.supplierEvidence).length;
  const tasks = cases.flatMap(item => item.tasks);
  const observedFrom = cases.length ? cases.map(item => item.capturedAt).sort()[0] : snapshot.asOf;
  const statuses: WorkStatus[] = ['queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'stale'];
  const met = contacts.filter(row => row.timing.met).length;
  return <section className="wide-panel" aria-labelledby="dashboard-title"><div className="panel-heading"><div><p className="eyebrow">MUESTRA SINTÉTICA · DEMO</p><h2 id="dashboard-title">Una lectura con cobertura.</h2><p>Métricas derivadas de {cases.length} casos confirmados por la API. Esta muestra no mide resultados del negocio.</p><p className="dashboard-period">Periodo observado: {time(observedFrom)} → {time(snapshot.asOf)} UTC. Se cuentan sólo registros devueltos en esta lectura.</p></div><span className="tiny-tag">SIN DATOS DE CLIENTES</span></div>
    <div className="metric-grid"><article><p>Ventas cerradas · DEMO</p><strong>{closed}<span> / {cases.length}</span></strong><small>Cobertura de estado: {knownSales}/{cases.length} casos</small></article><article><p>Pagos verificados · DEMO</p><strong>{paid}<span> / {cases.length}</span></strong><small>Con evidencia sintética de pago</small></article><article><p>Proveedor aceptado · DEMO</p><strong>{supplierAccepted}<span> / {cases.length}</span></strong><small>Independiente del estado del pago</small></article><article><p>Revisiones por aprobar</p><strong>{countPending(cases)}</strong><small>Se cuentan revisiones pendientes, no envíos</small></article></div>
    <div className="dashboard-split"><article className="dashboard-card"><p className="eyebrow">CONTACTO HUMANO · DEMO</p><h3>Objetivo ≤ 30 segundos</h3><div className="sla-value">{contacts.length ? `${met}/${contacts.length}` : 'Sin muestra'}<span>contactos acreditados dentro del objetivo</span></div><p>Cobertura: {contacts.length}/{cases.length} casos con contacto humano sintético. {attempts}/{cases.length} con intento acreditado.</p><p className="form-hint">Se usa captura → contacto humano verificado. Los casos sin contacto no se convierten en cero ni se incluyen como éxito.</p></article><article className="dashboard-card"><p className="eyebrow">ESTADOS ILUSTRATIVOS</p><h3>{tasks.length} tareas con procedencia</h3><div className="status-distribution">{statuses.map(status => { const amount = tasks.filter(task => task.status === status).length; return <div key={status}><Status status={status} /><span className="distribution-track"><span style={{ width: `${tasks.length ? amount / tasks.length * 100 : 0}%` }} /></span><strong>{amount}</strong></div>; })}</div><p className="form-hint">«En curso» es un estado del escenario de prueba. No hay workers ni agentes ejecutándose.</p></article></div>
    <div className="table-wrap"><table><caption>Estado por caso · todos los valores son sintéticos</caption><thead><tr><th scope="col">Caso</th><th scope="col">Venta humana</th><th scope="col">Pago</th><th scope="col">Proveedor</th><th scope="col">Contacto humano</th><th scope="col">Procedencia</th></tr></thead><tbody>{cases.map(item => <tr key={item.id}><th scope="row">{item.title}</th><td>{item.saleClosed === true ? 'Cerrada' : item.saleClosed === false ? 'Abierta' : 'Sin evidencia'}</td><td>{PAYMENT[item.payment]}</td><td>{SUPPLIER[item.supplier]}</td><td>{callTiming(item).connectedSeconds === null ? 'Sin evidencia' : `${callTiming(item).connectedSeconds} s`}</td><td><EvidenceDetails evidence={item.evidence} /></td></tr>)}</tbody></table></div><p className="source-note">Fuente: {snapshot.note} Corte: {time(snapshot.asOf)} UTC{snapshot.hasMore ? '. Cobertura parcial: la API indica más registros fuera de esta lectura.' : '. Cobertura: todos los registros devueltos en esta lectura.'}</p>
  </section>;
}

export function OfficeApp() {
  const [session, setSession] = useState<DemoSession | null>(null);
  const [role, setRole] = useState<'operator' | 'viewer'>('viewer');
  const [snapshot, setSnapshot] = useState<OfficeSnapshot | null>(null);
  const [caseId, setCaseId] = useState('demo-aurora');
  const [functionId, setFunctionId] = useState<FunctionId>('sales');
  const [view, setView] = useState<View>('workspace');
  const [busy, setBusy] = useState<'boot' | 'session' | 'refresh' | 'command' | null>('boot');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draftText, setDraftText] = useState('');
  const [chatText, setChatText] = useState('');
  const [pendingCommand, setPendingCommand] = useState<OfficeCommand | null>(readPendingCommand);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(true);
  const operation = useRef(false);
  const lastFailure = useRef<unknown>(null);
  const request = useRef<AbortController | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = snapshot?.cases.find(item => item.id === caseId) ?? snapshot?.cases[0] ?? null;
  const activeFunction = functionById(functionId);
  const activeArea = areaById(activeFunction.area);
  const expired = !!session && Date.parse(session.expiresAt) <= now;
  const canWrite = !!session && !expired && session.role === 'operator' && !!current && session.caseIds.includes(current.id) && session.functionIds.includes(functionId) && !pendingCommand;
  const canRetry = !!session && !expired && session.role === 'operator' && !!pendingCommand && session.caseIds.includes(pendingCommand.caseId) && session.functionIds.includes(pendingCommand.functionId);
  const supplierBlocked = functionId === 'suppliers' && current?.saleClosed !== true;
  const approvals = current?.approvals.filter(item => item.functionId === functionId) ?? [];
  const tasks = current?.tasks.filter(item => item.functionId === functionId) ?? [];
  const results = current?.results.filter(item => item.functionId === functionId) ?? [];
  const messages = [...(current?.messages.filter(item => item.functionId === functionId) ?? [])].sort((a, b) => a.evidence.at.localeCompare(b.evidence.at) || Number(!a.author.startsWith('Operador')) - Number(!b.author.startsWith('Operador')) || a.id.localeCompare(b.id));
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    request.current = controller;
    void (async () => {
      try {
        const found = await loadDemoSession(controller.signal);
        if (!mounted.current) return;
        setSession(found);
        if (found) {
          const data = await loadDemoSnapshot(controller.signal);
          if (mounted.current) setSnapshot(data);
        }
      } catch (failure) { if (mounted.current && !controller.signal.aborted) setError(message(failure)); }
      finally { if (mounted.current && !controller.signal.aborted) setBusy(null); }
    })();
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { mounted.current = false; controller.abort(); window.clearInterval(timer); };
  }, []);
  useEffect(() => { setDraftText(''); setChatText(''); }, [caseId, functionId]);
  async function run<T>(kind: 'session' | 'refresh' | 'command', work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    if (operation.current) return undefined;
    operation.current = true;
    const controller = new AbortController();
    request.current = controller;
    setBusy(kind); setError(''); setNotice(''); lastFailure.current = null;
    try { return await work(controller.signal); }
    catch (failure) { lastFailure.current = failure; if (mounted.current && !controller.signal.aborted) { setError(message(failure)); if (failure instanceof OfficeReadError && failure.code === 'unauthorized') setSession(null); } return undefined; }
    finally { operation.current = false; if (mounted.current && !controller.signal.aborted) { setBusy(null); setNow(Date.now()); } }
  }
  async function openSession() {
    await run('session', async signal => {
      const found = await startDemoSession({ role, caseIds: ['demo-aurora', 'demo-cedar', 'demo-harbor'], functionIds: FUNCTIONS.map(item => item.id) }, signal);
      if (!mounted.current) return;
      setSession(found);
      const data = await loadDemoSnapshot(signal);
      if (mounted.current) { setSnapshot(data); setNotice(`Sesión de desarrollo abierta: ${found.role === 'operator' ? 'operador DEMO' : 'consulta DEMO'}. Lectura confirmada por la API.`); }
    });
  }
  async function refresh() {
    await run('refresh', async signal => { const data = await loadDemoSnapshot(signal); if (mounted.current) { setSnapshot(data); setNotice('Oficina actualizada desde la API de desarrollo.'); } });
  }
  async function closeSession() {
    await run('session', async signal => { await endDemoSession(signal); if (mounted.current) { setSession(null); setSnapshot(null); setNotice('Sesión cerrada. Los registros permanecen en el servicio de desarrollo.'); } });
  }
  function retainPending(command: OfficeCommand | null) {
    setPendingCommand(command);
    try { if (command) sessionStorage.setItem(PENDING_KEY, JSON.stringify(command)); else sessionStorage.removeItem(PENDING_KEY); } catch { /* The current tab still retains its unconfirmed intent. */ }
  }
  async function confirmCommand(command: OfficeCommand): Promise<boolean> {
    const response = await run('command', signal => executeDemoCommand(command, signal));
    if (!response || !mounted.current) {
      const failure = lastFailure.current;
      if (failure instanceof OfficeReadError && ['validation', 'conflict', 'forbidden', 'unauthorized'].includes(failure.code)) retainPending(null);
      return false;
    }
    retainPending(null);
    setSnapshot(response.snapshot);
    const labels = { draft: 'Borrador preparado para revisión humana.', chat: 'Pregunta y respuesta guionada guardadas.', approve: 'Aprobación DEMO registrada. La ejecución externa sigue bloqueada.', reject: 'Rechazo DEMO registrado.', cancel: 'Cancelación DEMO registrada.', revise: 'Nueva revisión guardada. Requiere una nueva decisión.' };
    setNotice(`${labels[command.action]}${response.replayed ? ' La API reconoció una operación ya confirmada.' : ''}`);
    return true;
  }
  async function submit(input: CommandInput): Promise<boolean> {
    if (!canWrite || operation.current) return false;
    const command = { ...input, idempotencyKey: `office-${crypto.randomUUID()}` };
    retainPending(command);
    return confirmCommand(command);
  }
  async function retryPending() { if (pendingCommand && canRetry && !operation.current) await confirmCommand(pendingCommand); }
  async function prepareDraft(event: FormEvent) { event.preventDefault(); if (!current || supplierBlocked) return; if (await submit({ action: 'draft', caseId: current.id, functionId, ...(draftText.trim() ? { text: draftText.trim() } : {}) })) setDraftText(''); }
  async function sendChat(event: FormEvent) { event.preventDefault(); if (!current || !chatText.trim()) return; if (await submit({ action: 'chat', caseId: current.id, functionId, text: chatText.trim() })) setChatText(''); }
  function selectArea(area: AreaId) { const selected = FUNCTIONS.find(item => item.area === area); if (selected) setFunctionId(selected.id); }
  function tabKeys(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % VIEWS.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + VIEWS.length) % VIEWS.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = VIEWS.length - 1;
    if (next !== null) { event.preventDefault(); setView(VIEWS[next].id); tabs.current[next]?.focus(); }
  }
  return <div className="office-app"><a className="skip-link" href="#office-main">Saltar al contenido</a>
    <header className="office-header"><a className="brand" href="#office-main" aria-label="Gourmet · Oficina"><span className="brand-mark" aria-hidden="true">G</span><span>Gourmet<small>AI OFFICE</small></span></a><div className="environment-tag"><span aria-hidden="true" />Desarrollo · DEMO</div><div className="header-controls">{session && !expired ? <><span className="session-role">{session.role === 'operator' ? 'Operador' : 'Sólo lectura'} · DEMO</span><button className="text-button" disabled={busy !== null} onClick={() => void closeSession()}>Cerrar sesión</button></> : <span className="session-role">{busy === 'boot' ? 'Comprobando sesión…' : 'Sin sesión de desarrollo'}</span>}</div></header>
    <main id="office-main" className="office-main"><section className="office-intro"><div><p className="eyebrow">GOURMET CORPORATION</p><h1>La oficina, con<br /><em>criterio humano.</em></h1><p>Nueve funciones para preparar el trabajo.<br />La revisión humana acompaña cada decisión de la demo.</p></div><div className="intro-summary"><span className="summary-symbol" aria-hidden="true">✳</span><div><strong>{snapshot ? countPending(snapshot.cases) : '—'}</strong><span>revisiones por aprobar</span></div><p>Datos sintéticos. Ninguna acción de esta oficina envía mensajes o ejecuta pagos.</p></div></section>
    <section className="service-status" aria-label="Estado de conexiones y almacenamiento"><span><i className={`service-dot ${session && !expired ? 'confirmed' : ''}`} aria-hidden="true" />{session && !expired ? 'Sesión de desarrollo activa' : expired ? 'Sesión expirada' : 'Sesión de desarrollo pendiente'}</span><span>{session?.storage.durable && !expired ? 'PostgreSQL de desarrollo · persistencia confirmada por API' : 'Sin almacenamiento confirmado en esta vista'}</span><span>LLM y conectores externos: sin conectar</span></section>
    {(!session || expired) && <section className="session-gate" aria-labelledby="session-title"><div><h2 id="session-title">Abre una sesión de desarrollo.</h2><p>Acceso explícito a tres casos inventados. El chat usa respuestas guionadas locales; no consulta un modelo. Elegir un permiso DEMO no acredita identidad ni amplía el acceso autorizado por el servidor.</p></div><div className="session-form"><label htmlFor="session-role">Permiso de sesión<select id="session-role" value={role} disabled={busy !== null} onChange={event => setRole(event.target.value as 'operator' | 'viewer')}><option value="viewer">Consulta DEMO</option><option value="operator">Operador DEMO</option></select></label><button className="button button-primary" disabled={busy !== null} onClick={() => void openSession()}>{busy === 'session' ? 'Abriendo sesión…' : 'Abrir sesión de desarrollo'}</button></div></section>}
    <div className="feedback" aria-live="polite" aria-atomic="true">{error && <div className="error-banner" role="alert"><span aria-hidden="true">!</span><div><strong>No se pudo confirmar la operación.</strong><p>{error}{snapshot ? ' Se conserva la última lectura confirmada; no se presentan cambios nuevos como confirmados.' : ''}</p></div></div>}{notice && <p className="notice-banner"><span aria-hidden="true">✓</span>{notice}</p>}{busy === 'command' && <p className="notice-banner">Confirmando la operación con la API…</p>}</div>
    {pendingCommand && busy !== 'command' && <section className="pending-intent" aria-label="Operación sin confirmación"><div><strong>Hay una operación sin confirmación.</strong><p>Se conserva únicamente la intención sintética y su clave de operación en esta pestaña. La API debe confirmar si fue guardada; las nuevas acciones esperan esa confirmación.</p><small>{pendingCommand.caseId} · {functionById(pendingCommand.functionId).name} · {pendingCommand.action}</small></div><button className="button button-secondary" disabled={!canRetry || busy !== null} onClick={() => void retryPending()}>Reintentar operación exacta</button></section>}
    <div className="office-toolbar"><div className="view-tabs" role="tablist" aria-label="Vistas de la oficina">{VIEWS.map((item, index) => <button key={item.id} ref={node => { tabs.current[index] = node; }} id={`tab-${item.id}`} role="tab" type="button" aria-selected={view === item.id} aria-controls={`panel-${item.id}`} tabIndex={view === item.id ? 0 : -1} onKeyDown={event => tabKeys(event, index)} onClick={() => setView(item.id)}>{item.title}{item.id === 'workspace' && <span aria-hidden="true">↗</span>}</button>)}</div><button className="text-button refresh-button" disabled={!session || expired || busy !== null} onClick={() => void refresh()}><span aria-hidden="true">↻</span> Actualizar oficina</button></div>
    <section className="case-bar" aria-label="Selección de caso"><div className="case-select"><label htmlFor="office-case">Caso de demostración</label><select id="office-case" value={current?.id ?? ''} disabled={!snapshot || busy !== null} onChange={event => setCaseId(event.target.value)}>{snapshot?.cases.length ? snapshot.cases.map(item => <option key={item.id} value={item.id}>{item.title}</option>) : <option value="">Sin casos confirmados</option>}</select></div><div className="case-context"><span className="tiny-tag">DEMO · SINTÉTICO</span><p>{current?.subtitle ?? 'Los casos aparecerán después de una lectura confirmada por la API.'}</p>{snapshot && <small>Última lectura: {time(snapshot.asOf)} UTC</small>}</div></section>
    {snapshot && <details className="snapshot-provenance"><summary>Procedencia de la lectura</summary><p>{snapshot.note}</p></details>}
    {snapshot?.hasMore && <p className="coverage-banner">Cobertura parcial: hay más registros fuera de esta lectura. Historial y métricas usan únicamente los registros visibles devueltos por la API.</p>}
    <div id={`panel-${view}`} role="tabpanel" aria-labelledby={`tab-${view}`}>
      {view === 'workspace' && <div className="workspace-grid"><section className="office-space" aria-labelledby="space-title"><div className="section-heading"><div><p className="eyebrow">UN ESPACIO COMPARTIDO</p><h2 id="space-title">¿Qué preparamos hoy?</h2></div><span className="tiny-tag">5 ÁREAS · 9 FUNCIONES</span></div><OfficeScene selected={activeFunction.area} onSelect={selectArea} current={current} /><nav className="function-grid" aria-label="Nueve funciones de la oficina">{FUNCTIONS.map(item => <button key={item.id} type="button" aria-pressed={functionId === item.id} className={`function-button ${functionId === item.id ? 'active' : ''}`} onClick={() => setFunctionId(item.id)}><span className="function-glyph" aria-hidden="true">{item.glyph}</span><span>{item.name}</span><span className="function-arrow" aria-hidden="true">↗</span></button>)}</nav><div className="connections-note"><span aria-hidden="true">◇</span><p><strong>Funciones preparadas, agentes sin conectar.</strong> Esta escena es una ilustración original. La presencia de una figura no acredita un agente o una persona disponible.</p></div>{current && <CaseFacts current={current} />}</section>
      <section className="work-panel" aria-labelledby="function-title"><div className="function-heading"><p className="eyebrow">{activeArea.name.toUpperCase()} · FUNCIÓN VIRTUAL</p><h2 id="function-title">{activeFunction.name}</h2><p className="function-role">{activeFunction.role}</p><p>{activeFunction.description}</p><div className="function-facts"><span><strong>Se activa con</strong>{activeFunction.trigger}</span><span><strong>Fuentes necesarias</strong>{activeFunction.sources.join(' · ')}</span></div>{functionId === 'proposals' && <p className="pages-note">Páginas se integra en Propuestas. Puedes revisar contenido sintético con este flujo; falta una plantilla autorizada para generar la página. No hay página ni URL publicada.</p>}<span className="connection-label"><i aria-hidden="true" />Sin agente ni fuentes reales conectados</span></div>
        {!current ? <Empty title="Un caso, antes de empezar">Abre una sesión de desarrollo. Las tareas, conversaciones y revisiones se cargarán desde la API.</Empty> : <>
          <section className="work-section" aria-label={`Tareas de ${activeFunction.name}`}><div className="section-heading"><h3>Tareas y resultados</h3><span className="tiny-tag">DEMO</span></div>{tasks.map(task => <article className="task-card" key={task.id}><div className="card-title-row"><h4>{task.title}</h4><Status status={task.status} /></div><p>{task.detail}</p><EvidenceDetails evidence={task.evidence} /></article>)}{results.map(result => <article className="result-card" key={result.id}><p className="eyebrow">RESULTADO · DEMO</p><h4>{result.title}</h4><p>{result.detail}</p><EvidenceDetails evidence={result.evidence} /></article>)}{!tasks.length && !results.length && <p className="form-hint">No hay tareas ni resultados confirmados para esta función.</p>}</section>
          <section className="work-section draft-section" aria-labelledby="draft-title"><div className="section-heading"><h3 id="draft-title">Prepara un borrador.</h3><span className="tiny-tag">REVISIÓN HUMANA</span></div><p>Usa sólo datos inventados. Puedes escribir el contenido o preparar el guion local de esta función.</p>{supplierBlocked && <p className="inline-alert">Buscar chef requiere una venta humana cerrada. Este caso sigue abierto; la preparación de proveedor está bloqueada.</p>}{session?.role === 'viewer' && <p className="inline-alert">Esta sesión tiene permiso de consulta. Registrar decisiones requiere un permiso de operador autorizado por el servidor.</p>}<form onSubmit={prepareDraft}><label htmlFor="draft-content">Contenido del borrador</label><textarea id="draft-content" rows={4} maxLength={2000} value={draftText} disabled={!canWrite || busy !== null || supplierBlocked} placeholder="Ej. Preparar un brief inventado para una cena de equipo…" onChange={event => setDraftText(event.target.value)} /><div className="form-actions"><small>{draftText.length}/2000 · {draftText.trim() ? 'contenido sintético' : 'vacío: se usará el guion local'}</small><button className="button button-primary" disabled={!canWrite || busy !== null || supplierBlocked}>Preparar borrador <span aria-hidden="true">↗</span></button></div></form></section>
          <section className="work-section approvals-section" aria-labelledby="approvals-title"><div className="section-heading"><h3 id="approvals-title">Revisiones y decisiones</h3><span className="count-badge">{approvals.filter(item => item.status === 'pending').length} pendientes</span></div>{approvals.length ? [...approvals].reverse().map(approval => <ApprovalCard key={`${current.id}:${approval.id}`} approval={approval} caseId={current.id} canWrite={canWrite && !supplierBlocked} busy={busy !== null} submit={submit} />) : <p className="form-hint">Aún no hay borradores para revisar en esta función.</p>}</section>
          <section className="work-section chat-section" aria-labelledby="chat-title"><div className="section-heading"><div><h3 id="chat-title">Conversación contextual</h3><p className="form-hint">{current.title} · {activeFunction.name}</p></div><span className="tiny-tag">GUION LOCAL</span></div><p className="chat-disclosure">Sin LLM conectado. La respuesta guionada usa el caso y la función seleccionados; no consulta fuentes externas.</p><div className="message-list" role="log" aria-label={`Conversación de ${activeFunction.name}`} aria-live="polite">{messages.length ? messages.map(item => <article className={`message ${item.author.startsWith('Operador') ? 'message-human' : ''}`} key={item.id}><p className="message-author">{item.author}<span>DEMO</span></p><p>{item.text}</p><EvidenceDetails evidence={item.evidence} /></article>) : <p className="form-hint">No hay conversación confirmada en esta función.</p>}</div><form onSubmit={sendChat}><label htmlFor="chat-message">Mensaje contextual</label><textarea id="chat-message" rows={3} maxLength={2000} required disabled={!canWrite || busy !== null} value={chatText} onChange={event => setChatText(event.target.value)} placeholder="Escribe una pregunta con datos inventados…" /><div className="form-actions"><small>{chatText.length}/2000 · sólo DEMO</small><button className="button button-primary" disabled={!canWrite || busy !== null || !chatText.trim()}>Guardar pregunta <span aria-hidden="true">↗</span></button></div></form></section>
        </>}
      </section></div>}
      {view === 'history' && (snapshot ? <HistoryView snapshot={snapshot} current={current} /> : <Empty title="Historial sin lectura confirmada">Abre una sesión de desarrollo para consultar registros sintéticos guardados por la API.</Empty>)}
      {view === 'dashboard' && (snapshot ? <DashboardView snapshot={snapshot} /> : <Empty title="Dashboard sin lectura confirmada">Las métricas se calcularán con casos confirmados por la API, incluyendo su cobertura y procedencia.</Empty>)}
    </div>
    <footer className="office-footer"><span>GOURMET · UN OPERADOR HUMANO, NUEVE FUNCIONES</span><span>Desarrollo DEMO · 0 envíos externos · 0 escrituras en Monday</span>{session && <small>Sesión hasta {time(session.expiresAt)} UTC</small>}</footer>
    </main>
  </div>;
}
