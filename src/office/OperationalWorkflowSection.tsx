import { useState } from 'react';
import type { OfficeCase, OfficeCommand } from './contracts';
import { MILESTONE_LABELS, operationalFunction } from './operational-contracts';
import type { OperationalMilestone, OperationalOperation, OperationalRecord } from './operational-contracts';

type Detail<T = OperationalOperation> = T extends OperationalOperation ? Omit<T, 'eventId' | 'revision' | 'contextDigest'> : never;
const LABELS: Record<OperationalOperation['step'], string> = { set_policy: 'Política de ensayo', record_receipt: 'Recepción de ensayo', confirm_milestone: 'Hito de ensayo', open_incident: 'Incidencia DEMO', acknowledge_incident: 'Acuse', resolve_incident: 'Resolución DEMO', close_demo: 'Cierre de ensayo' };
const STATUS = { blocked: 'Cierre bloqueado', review_ready: 'Listo para revisión de ensayo', closed_demo: 'Cierre de ensayo registrado', stale: 'Cierre de ensayo requiere revisión' };
function RecordDetails({ record, current }: { record: OperationalRecord; current: string }) {
  return <article className="task-card" data-testid={`operational-record-${record.id}`} style={{ overflowWrap: 'anywhere' }}>
    <h4>{LABELS[record.operation.step]} · revisión {record.revision}</h4>
    <p>{record.actorId} · {record.evidence.at} · {record.operation.contextDigest === current ? 'Dependencias vigentes' : 'Evidencia anterior: requiere revisión'}</p>
    {record.operation.step === 'open_incident' && <p>{record.operation.description} · responsable: {record.operation.owner} · hito: {record.operation.milestone ? MILESTONE_LABELS[record.operation.milestone] : 'Evento general'}</p>}
    {record.operation.step === 'resolve_incident' && <p>{record.operation.resolution}</p>}
    {record.operation.step === 'set_policy' && <p>{record.operation.policyFixtureId ?? 'Sin política: cierre bloqueado'}</p>}
    {record.operation.step === 'confirm_milestone' && <p>{MILESTONE_LABELS[record.operation.milestone]}</p>}
    {record.proof && <><p>Fuente: fixture local confiable · {record.proof.fixtureId} · {record.proof.status}</p>
      {record.proof.items.map(item => <p key={item.id}>{item.label}: esperado {item.expected} {item.unit}; recibido de ensayo {item.received} {item.unit}</p>)}
      <p>Fecha del hecho de ensayo: {record.proof.occurredAt}</p><p>SHA-256 del contenido: {record.proof.contentHash ?? 'Sin contenido verificable · reference_only'}</p>
      {record.proof.content !== null && <details><summary>Contenido sintético exacto</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.proof.content}</pre></details>}</>}
    <details><summary>Identidad y trazabilidad del registro</summary><p>Caso {record.caseId} · evento {record.eventId}</p><p>{record.id}</p><p>Huella del registro: {record.digest}</p><p>Dependencias: {record.operation.contextDigest}</p><p>{record.evidence.reference}</p></details>
  </article>;
}
export function OperationalWorkflowSection({ current, functionId, canWrite, canClose, busy, submit }: {
  current: OfficeCase; functionId: 'logistics' | 'quality'; canWrite: boolean; canClose: boolean; busy: boolean;
  submit: (input: Omit<OfficeCommand, 'idempotencyKey'>) => Promise<boolean>;
}) {
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState<'coordination_demo' | 'quality_demo'>('coordination_demo');
  const [milestone, setMilestone] = useState<OperationalMilestone | ''>('');
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const view = current.operationalWorkflow;
  if (!view) return null;
  const disabled = !canWrite || busy;
  const run = (detail: Detail) => {
    const operational: OperationalOperation = { ...detail, eventId: view.eventId, revision: view.revision, contextDigest: view.contextDigest };
    return submit({ caseId: current.id, functionId: operationalFunction(operational), action: 'draft', operational });
  };
  const records = functionId === 'logistics' ? view.logistics?.records : view.quality?.records;
  return <section className="work-section" data-testid="operational-workflow" style={{ overflowWrap: 'anywhere' }}>
    <div className="section-heading"><h3>Registro operativo · DEMO</h3><span className="tiny-tag">SÓLO ENSAYO</span></div>
    <p>Caso {view.caseId} · evento {view.eventId} · revisión {view.revision}. Sin ejecución ni aceptación real, requisitos alimentarios o cierre financiero. No habilitado comercialmente.</p>
    <article className="result-card" data-testid="operational-policy"><h4>{view.policy?.label ?? 'Sin política operativa'}</h4>
      {view.policy ? <ul>{view.policy.requirements.map(text => <li key={text}>{text}</li>)}</ul> : <p>Falta política operativa; no se infieren mínimos ni firmante.</p>}
      {functionId === 'logistics' && <div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || view.policy !== null} onClick={() => void run({ step: 'set_policy', policyFixtureId: view.policyFixtures[0].id })}>Usar política sintética v1</button><button type="button" className="button button-quiet" disabled={disabled || view.policy === null} onClick={() => void run({ step: 'set_policy', policyFixtureId: null })}>Retirar política de ensayo</button></div>}
    </article>
    <article className="task-card" data-testid="operational-status"><h4>{STATUS[view.closure.status]}</h4>
      <p>Reserva interna: {view.summary.activeAssignmentId ?? 'Pendiente'} · opción de abastecimiento: {view.summary.selectedOptionId ?? 'Pendiente'}</p>
      <p>Recepción de ensayo: {view.summary.receipt}</p>{view.summary.milestones.map(m => <p key={m.id}>{m.label}: {m.current ? 'Confirmado DEMO' : 'Pendiente o desactualizado'}</p>)}
      {view.blockers.length > 0 && <ul>{view.blockers.map(text => <li key={text}>{text}</li>)}</ul>}
      {view.closure.status === 'stale' && <p>Los registros de cierre anteriores se conservan. Hay hechos posteriores o dependencias que requieren otra revisión.</p>}
      <details><summary>Huella exacta para revisión del cierre</summary><p>{view.closure.reviewDigest}</p><p>Dependencias: {view.contextDigest}</p></details>
    </article>
    {functionId === 'logistics' && view.logistics && <>
      <h4>Recepción y comprobantes sintéticos</h4><p>Registrar una recepción de ensayo no emite ni acredita pedidos, entregas o pagos reales.</p>
      {view.logistics.receiptFixtures.map(f => <div className="task-card" key={f.id}><p>{f.label}</p><button type="button" className="button button-secondary" disabled={disabled || !current.supplyWorkflow?.procurement?.options.some(o => o.id === view.summary.selectedOptionId && o.reviewStatus === 'approved_demo')} onClick={() => void run({ step: 'record_receipt', fixtureId: f.id })}>Registrar {f.label}</button></div>)}
      <h4>Hitos del fixture</h4>{view.logistics.milestoneFixtures.map(f => <article className="task-card" key={f.id}><h4>{MILESTONE_LABELS[f.milestone]}</h4><p>Comprobación sintética explícita; no confirma cumplimiento real.</p><button type="button" className="button button-secondary" disabled={disabled} onClick={() => void run({ step: 'confirm_milestone', milestone: f.milestone, fixtureId: f.id })}>Confirmar {MILESTONE_LABELS[f.milestone]} DEMO</button></article>)}
    </>}
    {functionId === 'quality' && view.quality && <>
      <h4>Incidencias del ensayo</h4><p>Un mensaje o borrador de Calidad no registra ni resuelve una incidencia. Estos registros son exclusivamente sintéticos.</p>
      <form onSubmit={event => { event.preventDefault(); void run({ step: 'open_incident', description, owner, ...(milestone ? { milestone } : {}) }).then(ok => { if (ok) setDescription(''); }); }}>
        <label>Descripción de incidencia DEMO<textarea maxLength={500} required disabled={disabled} value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label>Responsable del fixture<select disabled={disabled} value={owner} onChange={e => setOwner(e.target.value as typeof owner)}><option value="coordination_demo">Coordinación DEMO</option><option value="quality_demo">Calidad DEMO</option></select></label>
        <label>Hito afectado del fixture<select disabled={disabled} value={milestone} onChange={e => setMilestone(e.target.value as typeof milestone)}><option value="">Evento general</option>{Object.entries(MILESTONE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <button className="button button-secondary" disabled={disabled || !description.trim()}>Registrar incidencia DEMO</button>
      </form>
      {view.quality.incidents.map(i => <article className="task-card" key={i.id} data-testid={`operational-incident-${i.id}`}><h4>{i.description}</h4><p>{i.owner} · {i.status} · {i.status === 'resolved_demo' && !i.current ? 'Resolución desactualizada' : 'Registro del ensayo'}</p><p>Hito afectado: {i.milestone ? MILESTONE_LABELS[i.milestone] : 'Evento general'}</p>
        {i.status === 'open' && <button type="button" className="button button-secondary" disabled={disabled} onClick={() => void run({ step: 'acknowledge_incident', incidentId: i.id })}>Registrar acuse DEMO</button>}
        {(i.status !== 'resolved_demo' || !i.current) && <><label>Resolución de ensayo<textarea maxLength={500} disabled={disabled} value={resolutions[i.id] ?? ''} onChange={e => setResolutions(previous => ({ ...previous, [i.id]: e.target.value }))} /></label><button type="button" className="button button-secondary" disabled={disabled || !resolutions[i.id]?.trim()} onClick={() => void run({ step: 'resolve_incident', incidentId: i.id, resolution: resolutions[i.id], fixtureId: view.quality!.resolutionFixtureId })}>Registrar resolución con fixture DEMO</button></>}
      </article>)}
      <button type="button" className="button button-primary" disabled={disabled || !canClose || view.blockers.length > 0 || view.closure.status === 'closed_demo'} onClick={() => void run({ step: 'close_demo', reviewDigest: view.closure.reviewDigest })}>Confirmar cierre de ensayo</button>
      {!canClose && <p>Revisar el cierre requiere los permisos existentes de Logística y Calidad para este caso.</p>}
    </>}
    <details><summary>Historial operativo de {functionId === 'logistics' ? 'Logística' : 'Calidad'} ({records?.length ?? 0})</summary>{[...(records ?? [])].reverse().map(r => <RecordDetails key={r.id} record={r} current={view.contextDigest} />)}</details>
  </section>;
}
