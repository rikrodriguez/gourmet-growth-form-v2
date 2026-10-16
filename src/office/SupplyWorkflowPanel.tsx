import { useState, type ReactNode } from 'react';
import type { Evidence, OfficeApproval, OfficeCase, OfficeCommand } from './contracts';
import type {
  SupplyCandidate, SupplyCandidateAnnouncement, SupplyMenuFixture, SupplyOperation,
  SupplyPurchaseOption, SupplyPurchaseOptionFixture, SupplyPurchaseSnapshot,
  SupplyReviewContext, SupplyReviewStatus, SupplySource, SupplyTermsFixture,
  SupplyWindow, SupplyWorkflow, SyntheticSupplyEvent,
} from './supply-contracts';

type CommandInput = Omit<OfficeCommand, 'idempotencyKey'>;
type Fact = [label: string, value: ReactNode];
const SOURCES: Record<SupplySource, string> = {
  facebook_marketplace: 'Facebook Marketplace', facebook_groups: 'Facebook Groups',
  outreach_forms: 'Outreach forms', meetachef: 'MeetAChef',
};
const REVIEW: Record<SupplyReviewStatus, string> = {
  pending: 'Pendiente de aprobación', approved_demo: 'Aprobado DEMO',
  rejected_demo: 'Rechazado DEMO', cancelled_demo: 'Cancelado DEMO', stale: 'Revisión desactualizada',
};
const UNITS = { hour: 'hora', event: 'evento', g: 'g', unit: 'unidad' };

function at(value: string | null) {
  return value === null ? 'Sin verificación' : `${new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
}
function money(value: number | null, currency: 'USD' | null) {
  return value === null || currency === null ? 'Sin datos' : `${(value / 100).toFixed(2)} ${currency}`;
}
function unit(value: keyof typeof UNITS | null) { return value === null ? 'unidad sin validar' : UNITS[value]; }
function quantity(value: number | null, label: keyof typeof UNITS | null) { return value === null ? 'Cantidad sin validar' : `${value} ${unit(label)}`; }
function windowText(value: SupplyWindow | null) { return value === null ? 'Ventana sin verificar' : `${at(value.startAt)} → ${at(value.endAt)}`; }
function Facts({ values }: { values: Fact[] }) {
  return <dl className="approval-target">{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function SupplyEvidence({ evidence }: { evidence: Evidence }) {
  return <details className="evidence"><summary>Procedencia sintética <span aria-hidden="true">↗</span></summary><dl><dt>Origen</dt><dd>{evidence.source}</dd><dt>Referencia</dt><dd className="reference">{evidence.reference}</dd><dt>Registro</dt><dd>{at(evidence.at)}</dd><dt>Tipo</dt><dd>{evidence.simulated ? 'DEMO · evidencia sintética' : 'Evidencia observada'}</dd></dl></details>;
}
function EventDetails({ event }: { event: SyntheticSupplyEvent }) {
  return <><Facts values={[
    ['Evento sintético', event.id], ['Caso', event.caseId], ['Revisión del evento', event.revision],
    ['Ciudad', event.city], ['Cobertura requerida', event.coverage], ['Ventana del evento', windowText(event.window)],
  ]} /><SupplyEvidence evidence={event.evidence} /></>;
}
function AnnouncementDetails({ announcement }: { announcement: SupplyCandidateAnnouncement }) {
  return <Facts values={[
    ['Anuncio', announcement.label], ['Referencia del anuncio', announcement.id], ['Candidato', announcement.candidateId],
    ['Fuente', SOURCES[announcement.source]], ['Referencia de la fuente', announcement.sourceLink],
    ['Contacto ficticio', announcement.contact], ['Ciudad anunciada', announcement.city ?? 'Ciudad sin validar'],
    ['Cobertura anunciada', announcement.coverage?.join(' · ') || 'Cobertura sin validar'], ['Lectura de la fuente', at(announcement.readAt)],
    ['Tarifa anunciada', `${money(announcement.announcedRateCents, announcement.currency)} / ${unit(announcement.announcedRateUnit)}`],
  ]} />;
}
function TermsDetails({ terms }: { terms: SupplyTermsFixture | NonNullable<SupplyCandidate['terms']> }) {
  return <><Facts values={[
    ['Condiciones sintéticas', terms.label], ['Referencia de condiciones', terms.id], ['Candidato de las condiciones', terms.candidateId],
    ['Tarifa propuesta', `${money(terms.rateCents, terms.currency)} / ${unit(terms.rateUnit)}`],
    ['Cantidad acordable', quantity(terms.quantity, terms.rateUnit)], ['Total de condiciones', money(terms.totalCents, terms.currency)],
    ['Condiciones', terms.conditions ?? 'Condiciones sin validar'],
    ...('checkedAt' in terms ? [['Validación de condiciones', at(terms.checkedAt)], ['Revisor de condiciones', terms.checkedBy]] as Fact[] : []),
  ]} /><SupplyEvidence evidence={terms.evidence} /></>;
}
function CandidateDetails({ candidate, showTerms = true }: { candidate: SupplyCandidate; showTerms?: boolean }) {
  return <><Facts values={[
    ['Candidato ficticio', candidate.label], ['Referencia del candidato', candidate.id], ['Caso del candidato', candidate.caseId], ['Revisión del candidato', candidate.revision],
    ['Fuente', SOURCES[candidate.source]], ['Referencia de la fuente', candidate.sourceLink], ['Contacto ficticio', candidate.contact],
    ['Ciudad anunciada', candidate.city ?? 'Ciudad sin validar'], ['Cobertura anunciada', candidate.coverage?.join(' · ') || 'Cobertura sin validar'],
    ['Lectura de la fuente', at(candidate.readAt)], ['Tarifa anunciada', `${money(candidate.announcedRateCents, candidate.currency)} / ${unit(candidate.announcedRateUnit)}`],
    ['Evaluación humana DEMO', candidate.evaluation.verdict === 'eligible' ? 'Elegible' : candidate.evaluation.verdict === 'rejected' ? 'Rechazado' : 'Pendiente'],
    ['Fecha de evaluación', at(candidate.evaluation.checkedAt)], ['Revisor de evaluación', candidate.evaluation.checkedBy ?? 'Sin revisor'],
    ['Disponibilidad DEMO', candidate.availability.status === 'available' ? 'Disponible · verificación sintética' : candidate.availability.status === 'unavailable' ? 'No disponible · verificación sintética' : 'Sin verificar'],
    ['Ventana verificada', windowText(candidate.availability.window)], ['Fecha de disponibilidad', at(candidate.availability.checkedAt)],
    ['Revisor de disponibilidad', candidate.availability.checkedBy ?? 'Sin revisor'], ['Contratación externa', candidate.externalHired ? 'No compatible con DEMO' : 'Sin contratar'],
  ]} /><p className="form-hint">La tarifa del anuncio es informativa. La evaluación, la disponibilidad y las condiciones se registran por separado.</p>
  {showTerms && (candidate.terms ? <><h4>Condiciones validadas · DEMO</h4><TermsDetails terms={candidate.terms} /></> : <p className="form-hint">Sin condiciones validadas.</p>)}
  <details className="evidence" open><summary>Anuncios conservados · {candidate.announcements.length}</summary>{candidate.announcements.map(announcement => <div key={announcement.id}><AnnouncementDetails announcement={announcement} /></div>)}</details>
  <SupplyEvidence evidence={candidate.evidence} /></>;
}

function MenuDetails({ menu }: { menu: SupplyMenuFixture }) {
  return <><Facts values={[
    ['Menú sintético', menu.label], ['Referencia del menú', menu.id], ['Revisión del menú', menu.menuRevision],
  ]} /><h4>Platos y porciones para validar</h4>{menu.items.map(item => <article className="result-card" key={item.id}><h4>{item.label}</h4><Facts values={[
    ['Plato', item.id], ['Porciones', item.servings ?? 'Porciones sin validar'], ['Receta vinculada', item.recipeId ?? 'Receta faltante'],
  ]} /></article>)}<h4>Recetas, cantidades y unidades para validar</h4>{menu.recipes.map(recipe => {
    const uses = menu.items.filter(item => item.recipeId === recipe.id);
    const servings = uses.length && uses.every(item => item.servings !== null) ? uses.reduce((sum, item) => sum + item.servings!, 0) : null;
    return <article className="result-card" key={recipe.id}><h4>{recipe.label}</h4><Facts values={[
      ['Receta', recipe.id], ['Porciones vinculadas', servings ?? 'Porciones sin validar'],
    ]} />{recipe.ingredients.map(ingredient => <Facts key={ingredient.id} values={[
      ['Ingrediente', ingredient.label], ['Referencia del ingrediente', ingredient.id],
      ['Cantidad por porción', quantity(ingredient.quantityPerServing, ingredient.unit)],
      ['Cantidad para el menú', quantity(servings === null || ingredient.quantityPerServing === null ? null : servings * ingredient.quantityPerServing, ingredient.unit)],
    ]} />)}</article>;
  })}{!menu.recipes.length && <p className="inline-alert">Falta la receta. No hay cantidades verificadas para construir la lista.</p>}<SupplyEvidence evidence={menu.evidence} /></>;
}
function ListDetails({ list }: { list: SupplyPurchaseSnapshot['list'] }) {
  return <><Facts values={[
    ['Lista', list.id], ['Caso de la lista', list.caseId], ['Revisión de la lista', list.revision], ['Revisión del menú validado', list.menuRevision],
    ['Huella del menú', list.menuDigest], ['Huella de la lista', list.digest], ['Fecha de preparación', at(list.createdAt)],
  ]} />{list.items.map(item => <Facts key={item.id} values={[
    ['Ingrediente', item.label], ['Referencia', item.id], ['Cantidad de la lista', quantity(item.quantity, item.unit)],
  ]} />)}<SupplyEvidence evidence={list.evidence} /></>;
}
function OptionDetails({ option }: { option: SupplyPurchaseSnapshot['option'] | SupplyPurchaseOption }) {
  return <><Facts values={[
    ['Opción sintética', option.label], ['Referencia de la opción', option.id], ['Caso de la opción', option.caseId], ['Fuente de la opción', option.fixtureId],
    ['Servicio de referencia', option.service === 'instacart' ? 'Instacart' : 'Servicio similar'], ['Revisión de la opción', option.revision],
    ['Revisión del menú', option.menuRevision], ['Revisión de la lista', option.listRevision], ['Dirección de entrega ficticia', option.deliveryAddress ?? 'Dirección sin validar'],
    ['Ventana de entrega', windowText(option.deliveryWindow)], ['Subtotal de ingredientes', money(option.itemsTotalCents, option.currency)],
    ['Entrega', money(option.deliveryFeeCents, option.currency)], ['Impuestos', money(option.taxCents, option.currency)], ['Coste total', money(option.totalCents, option.currency)],
    ['Sustituciones', option.substitutions === 'no_substitutions_demo' ? 'Sin sustituciones · DEMO' : 'Política sin validar'],
    ['Datos pendientes', option.missingFacts.length ? option.missingFacts.join(' · ') : 'Sin datos pendientes en esta opción sintética'],
    ['Pedido externo', 'Sin pedido'], ['Pago externo', 'Sin pago'], ['Recepción y recibos', 'Sin recepción ni recibos externos'],
  ]} />{option.items.map(item => <Facts key={item.id} values={[
    ['Ingrediente', item.label], ['Referencia del ingrediente', item.id], ['Cantidad', quantity(item.quantity, item.unit)],
    ['Precio por unidad de ingrediente', `${money(item.unitPriceCents, option.currency)} / ${unit(item.unit)}`], ['Coste del ingrediente', money(item.lineTotalCents, option.currency)],
  ]} />)}<SupplyEvidence evidence={option.evidence} /></>;
}

// This is a UI affordance; the API validates the exact immutable binding again.
// A historical review remains readable when the current workflow changes.
export function isSupplyReviewCurrent(approval: OfficeApproval, workflow: SupplyWorkflow | undefined): boolean {
  const context = approval.supplyContext;
  if (!context) return true;
  if (!workflow || workflow.event.caseId !== context.caseId) return false;
  const record = context.kind === 'selection'
    ? workflow?.sourcing?.selections.find(item => item.id === context.selectionId)
    : workflow?.procurement?.options.find(item => item.id === context.optionId);
  if (!record || record.reviewStatus === 'stale' || record.revision !== context.revision || record.digest !== context.digest || record.approvalId !== approval.id || record.reviewStatus !== approval.status) return false;
  if (context.kind === 'purchase') {
    const current = workflow?.procurement;
    return current?.selectedOptionId === context.optionId
      && current.menu?.revision === context.snapshot.menu.revision
      && current.menu.digest === context.snapshot.menu.digest
      && current.list?.revision === context.snapshot.list.revision
      && current.list.digest === context.snapshot.list.digest;
  }
  const candidate = workflow.sourcing?.candidates.find(item => item.id === context.snapshot.candidate.id);
  return candidate?.revision === context.snapshot.candidate.revision
    && workflow.event.id === context.snapshot.event.id
    && workflow.event.revision === context.snapshot.event.revision
    && workflow.event.window.startAt === context.snapshot.event.window.startAt
    && workflow.event.window.endAt === context.snapshot.event.window.endAt;
}

export function SupplyReviewDetails({ context }: { context: SupplyReviewContext }) {
  return <section data-testid="approval-supply-context" aria-label={context.kind === 'selection' ? 'Contexto exacto de selección DEMO' : 'Contexto exacto de compra DEMO'}>
    <h4>{context.kind === 'selection' ? 'Selección pendiente con sus condiciones' : 'Revisión de abastecimiento con su coste total'}</h4>
    <Facts values={[
      ['Caso de la revisión', context.caseId], ['Referencia de la revisión', context.kind === 'selection' ? context.selectionId : context.optionId],
      ['Revisión vinculada', context.revision], ['Huella del contexto', context.digest],
    ]} />
    {context.kind === 'selection' ? <><EventDetails event={context.snapshot.event} /><CandidateDetails candidate={context.snapshot.candidate} showTerms={false} /><h4>Condiciones exactas de la selección</h4><TermsDetails terms={context.snapshot.terms} /><p className="approval-policy">Aprobar DEMO permite registrar una asignación interna simulada en un paso separado. El candidato sigue sin contratar y la incidencia real conserva su estado.</p></> : <><MenuDetails menu={context.snapshot.menu} /><Facts values={[
      ['Estado de validación del menú', context.snapshot.menu.validation === 'validated_demo' ? 'Validado por humano · DEMO' : 'Bloqueado'],
      ['Revisión de validación', context.snapshot.menu.revision], ['Huella del menú validado', context.snapshot.menu.digest],
      ['Fecha de validación', at(context.snapshot.menu.validatedAt)], ['Revisor del menú', context.snapshot.menu.validatedBy ?? 'Sin revisor'],
      ['Datos pendientes del menú', context.snapshot.menu.missingFacts.length ? context.snapshot.menu.missingFacts.join(' · ') : 'Sin datos pendientes en el menú sintético'],
    ]} /><ListDetails list={context.snapshot.list} /><OptionDetails option={context.snapshot.option} /><p className="approval-policy">La aprobación registra la revisión interna DEMO. No ejecuta un pedido, pago, recepción ni contrato con el servicio de referencia.</p></>}
    <SupplyEvidence evidence={context.evidence} />
  </section>;
}

function OptionFixtureDetails({ option, list }: { option: SupplyPurchaseOptionFixture; list: SupplyPurchaseSnapshot['list'] | null }) {
  return <><Facts values={[
    ['Opción ficticia', option.label], ['Referencia de la opción', option.id], ['Servicio de referencia', option.service === 'instacart' ? 'Instacart' : 'Servicio similar'],
    ['Dirección de entrega ficticia', option.deliveryAddress ?? 'Dirección sin validar'], ['Ventana de entrega', windowText(option.deliveryWindow)],
    ['Entrega', money(option.deliveryFeeCents, option.currency)], ['Impuestos', money(option.taxCents, option.currency)],
    ['Sustituciones', option.substitutions === 'no_substitutions_demo' ? 'Sin sustituciones · DEMO' : 'Política sin validar'],
  ]} />{option.prices.map(price => {
    const item = list?.items.find(item => item.id === price.itemId);
    return <Facts key={price.itemId} values={[
      ['Ingrediente', item?.label ?? price.itemId], ['Cantidad de lista', item ? quantity(item.quantity, item.unit) : 'Lista aún no preparada'],
      ['Precio por unidad de ingrediente', `${money(price.unitPriceCents, option.currency)} / ${unit(item?.unit ?? null)}`],
    ]} />;
  })}<p className="form-hint">Preparar la opción calcula el coste total desde la lista confirmada. Ese total se mostrará antes de solicitar revisión.</p><SupplyEvidence evidence={option.evidence} /></>;
}

export function SupplyWorkflowPanel({ current, functionId, canWrite, busy, submit }: {
  current: OfficeCase; functionId: 'suppliers' | 'logistics'; canWrite: boolean; busy: boolean;
  submit: (input: CommandInput) => Promise<boolean>;
}) {
  const [withdrawalReasons, setWithdrawalReasons] = useState<Record<string, string>>({});
  const workflow = current.supplyWorkflow;
  const disabled = !canWrite || busy;
  const sourcing = functionId === 'suppliers' ? workflow?.sourcing : undefined;
  const procurement = functionId === 'logistics' ? workflow?.procurement : undefined;
  function run(supply: SupplyOperation) { return submit({ caseId: current.id, functionId, action: 'draft', supply }); }
  if (!workflow || (!sourcing && !procurement)) return <section className="work-section" data-testid={functionId === 'suppliers' ? 'supply-sourcing' : 'supply-procurement'}><h3>{functionId === 'suppliers' ? 'Búsqueda de cocinero' : 'Abastecimiento'}</h3><p className="form-hint">No hay un flujo confirmado dentro de los permisos de esta lectura. Actualiza antes de registrar un paso.</p></section>;
  return <section className="work-section" data-testid={functionId === 'suppliers' ? 'supply-sourcing' : 'supply-procurement'} aria-label={functionId === 'suppliers' ? 'Flujo de proveedores DEMO' : 'Flujo de compras DEMO'}>
    <div className="section-heading"><h3>{functionId === 'suppliers' ? 'Búsqueda de cocinero' : 'Abastecimiento'}</h3><span className="tiny-tag">DEMO · PERSISTENTE</span></div>
    <p>{functionId === 'suppliers' ? 'Fuente → candidato → evaluación humana → disponibilidad verificada → condiciones → selección revisable → asignación DEMO.' : 'Menú, recetas y cantidades → validación humana → lista → opción de entrega y coste total → revisión interna.'}</p>
    <p className="form-hint">Facebook Marketplace, Facebook Groups, outreach forms y MeetAChef son fuentes de referencia; Instacart y similares son opciones de abastecimiento. No hay APIs ni conectores activados. Todos los datos mostrados son ficticios.</p>
    <EventDetails event={workflow.event} />
    {sourcing && <>
      {current.saleClosed !== true && <p className="inline-alert">La búsqueda requiere una venta humana cerrada. Este caso no tiene ese cierre acreditado.</p>}
      {sourcing.queue ? <article className="task-card" data-testid="supply-queue"><h4>Cola de sourcing</h4><Facts values={[
        ['Referencia de la cola', sourcing.queue.id], ['Caso', sourcing.queue.caseId],
        ['Estado', sourcing.queue.status === 'queued' ? 'En cola' : 'Plan DEMO registrado'], ['Motivo', 'Evento vendido sin proveedor aceptado'],
        ['Creación', at(sourcing.queue.createdAt)], ['Actualización', at(sourcing.queue.updatedAt)], ['Resolución externa', 'Sin resolver'],
      ]} /><SupplyEvidence evidence={sourcing.queue.evidence} /></article> : <><p className="form-hint">Preparar la cola conserva la falta de cocinero como pendiente humano.</p><button type="button" className="button button-primary" disabled={disabled || current.saleClosed !== true || current.supplier === 'accepted'} onClick={() => void run({ step: 'queue_sourcing' })}>Preparar cola de sourcing</button></>}
      <h4>Digest ficticio para revisar</h4>{sourcing.digestFixtures.map(fixture => <article className="task-card" key={fixture.id}><h4>{fixture.label}</h4><Facts values={[
        ['Cantidad anunciada en asunto', fixture.announcedCount], ['Registros en cuerpo ficticio', fixture.entries.length],
      ]} /><p className="form-hint">La cantidad del asunto puede diferir del cuerpo. Extraer y deduplicar candidatos no acredita disponibilidad.</p><details className="evidence"><summary>Ver los registros ficticios del cuerpo</summary>{fixture.entries.map(entry => <div key={entry.id}><AnnouncementDetails announcement={entry} /></div>)}</details><SupplyEvidence evidence={fixture.evidence} /><div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || !sourcing.queue || current.saleClosed !== true} onClick={() => void run({ step: 'ingest_digest', fixtureId: fixture.id })}>Incorporar digest ficticio</button></div></article>)}
      {sourcing.digests.map(digest => <article className="result-card" key={digest.id} data-testid={`supply-digest-${digest.id}`}><h4>{digest.label}</h4><Facts values={[
        ['Cantidad del asunto', digest.announcedCount], ['Registros extraídos', digest.extractedCount], ['Candidatos únicos', digest.uniqueCount],
        ['Duplicados conservados', digest.duplicateCount], ['Discrepancia de cantidad', digest.countMismatch ? 'Asunto y cuerpo no coinciden' : 'Sin discrepancia'], ['Incorporación', at(digest.ingestedAt)],
      ]} /><SupplyEvidence evidence={digest.evidence} /></article>)}
      <h4>Candidatos por validar</h4>{!sourcing.candidates.length && <p className="form-hint">No hay candidatos incorporados. Las fuentes listadas no implican contactos realizados.</p>}
      {sourcing.candidates.map(candidate => {
        const terms = sourcing.termsFixtures.filter(fixture => fixture.candidateId === candidate.id);
        const ready = candidate.evaluation.verdict === 'eligible' && candidate.availability.status === 'available' && candidate.terms !== null;
        return <article className="task-card" key={candidate.id} data-testid={`supply-candidate-${candidate.id}`}><div className="card-title-row"><h4>{candidate.label}</h4><span className="tiny-tag">REVISIÓN {candidate.revision}</span></div><CandidateDetails candidate={candidate} /><div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || current.saleClosed !== true} onClick={() => void run({ step: 'evaluate_candidate', candidateId: candidate.id, revision: candidate.revision, verdict: 'eligible' })}>Evaluar como elegible DEMO</button><button type="button" className="button button-quiet" disabled={disabled || current.saleClosed !== true} onClick={() => void run({ step: 'evaluate_candidate', candidateId: candidate.id, revision: candidate.revision, verdict: 'rejected' })}>Marcar evaluación rechazada DEMO</button></div><div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || current.saleClosed !== true || candidate.evaluation.verdict !== 'eligible'} onClick={() => void run({ step: 'verify_availability', candidateId: candidate.id, revision: candidate.revision, status: 'available' })}>Verificar disponible DEMO</button><button type="button" className="button button-quiet" disabled={disabled || current.saleClosed !== true || candidate.evaluation.verdict !== 'eligible'} onClick={() => void run({ step: 'verify_availability', candidateId: candidate.id, revision: candidate.revision, status: 'unavailable' })}>Verificar no disponible DEMO</button></div>
          {terms.map(fixture => <article className="result-card" key={fixture.id}><h4>Condiciones para revisión humana</h4><TermsDetails terms={fixture} /><div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || current.saleClosed !== true || candidate.evaluation.verdict !== 'eligible' || candidate.availability.status !== 'available'} onClick={() => void run({ step: 'approve_terms', candidateId: candidate.id, revision: candidate.revision, termsFixtureId: fixture.id })}>Validar condiciones DEMO</button></div></article>)}
          {!terms.length && <p className="form-hint">Faltan condiciones sintéticas para este candidato. No se deducen de su anuncio.</p>}<div className="approval-actions"><button type="button" className="button button-primary" disabled={disabled || current.saleClosed !== true || !ready} onClick={() => void run({ step: 'select_candidate', candidateId: candidate.id, revision: candidate.revision })}>Preparar selección para aprobación</button></div>
        </article>;
      })}
      {sourcing.selections.map(selection => <article className="result-card" key={selection.id} data-testid={`supply-selection-${selection.id}`}><h4>Selección de {selection.snapshot.candidate.label}</h4><Facts values={[
        ['Selección', selection.id], ['Revisión', selection.revision], ['Decisión', REVIEW[selection.reviewStatus]], ['Fecha de decisión', at(selection.reviewedAt)],
        ['Revisión humana vinculada', selection.approvalId ?? 'Sin revisión vinculada'], ['Asignación interna', selection.assignedDemo ? 'Asignado DEMO · sin contratar' : sourcing.assignments.some(row => row.selectionId === selection.id && row.status === 'withdrawn_demo') ? 'Retirada DEMO · historial conservado' : 'Pendiente'], ['Ventana del evento', windowText(selection.snapshot.event.window)],
      ]} /><p className="form-hint">La selección se decide en Revisiones y decisiones. La asignación se registra después, sólo si la revisión está aprobada y no hay solapamientos.</p><div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || current.saleClosed !== true || selection.reviewStatus !== 'approved_demo' || selection.assignedDemo} onClick={() => void run({ step: 'assign_demo', selectionId: selection.id, revision: selection.revision })}>Registrar asignación DEMO</button></div><SupplyEvidence evidence={selection.evidence} /></article>)}
      {sourcing.assignments.map(assignment => <article className="result-card" key={assignment.id} data-testid={`supply-assignment-${assignment.id}`}><h4>{assignment.status === 'assigned_demo' ? 'Asignación interna DEMO registrada' : 'Asignación interna DEMO retirada'}</h4><Facts values={[
        ['Asignación', assignment.id], ['Candidato', assignment.candidateId], ['Caso', assignment.caseId], ['Selección', assignment.selectionId], ['Revisión seleccionada', assignment.selectionRevision],
        ['Aprobación vinculada', assignment.approvalId], ['Ventana reservada DEMO', windowText(assignment.window)], ['Fecha de asignación', at(assignment.assignedAt)],
        ['Estado de reserva', assignment.status === 'assigned_demo' ? 'Activa DEMO' : 'Retirada DEMO'], ['Revisión de asignación', assignment.revision ?? 1], ['Contratación externa', 'Sin contratar'],
      ]} />{assignment.status === 'assigned_demo' ? <>
        {sourcing.selections.find(row => row.id === assignment.selectionId)?.reviewStatus === 'stale' && <p className="inline-alert" role="status">Requiere revisión. La selección está obsoleta; la reserva sigue activa hasta una retirada explícita.</p>}
        <label>Motivo de retirada interna DEMO<input maxLength={500} value={withdrawalReasons[assignment.id] ?? ''} disabled={disabled} onChange={event => setWithdrawalReasons(previous => ({ ...previous, [assignment.id]: event.target.value }))} /></label>
        <div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || current.saleClosed !== true || !withdrawalReasons[assignment.id]?.trim()} onClick={() => void run({ step: 'withdraw_assignment', assignmentId: assignment.id, revision: assignment.revision ?? 1, reason: withdrawalReasons[assignment.id] })}>Retirar asignación interna DEMO</button></div>
      </> : <><Facts values={[
        ['Motivo de retirada', assignment.withdrawal.reason], ['Fecha de retirada', at(assignment.withdrawal.at)], ['Retirada por', assignment.withdrawal.by],
      ]} /><SupplyEvidence evidence={assignment.withdrawal.evidence} /></>}
      <p className="form-hint">Este plan interno no confirma al chef ni resuelve una incidencia real de proveedor. Cambiar disponibilidad no libera la reserva.</p><SupplyEvidence evidence={assignment.evidence} /></article>)}
    </>}
    {procurement && <>
      <h4>Menú y cantidades para revisión humana</h4>{procurement.menuFixtures.map(fixture => <article className="task-card" key={fixture.id} data-testid={`supply-menu-preview-${fixture.id}`}><MenuDetails menu={fixture} /><p className="form-hint">Revisa platos, recetas, porciones, cantidades y unidades antes de validar este menú ficticio.</p><div className="approval-actions"><button type="button" className="button button-primary" disabled={disabled} onClick={() => void run({ step: 'validate_menu', fixtureId: fixture.id })}>Validar menú y cantidades DEMO</button></div></article>)}
      {procurement.menu && <article className="result-card" data-testid="supply-menu-validated"><h4>Resultado de validación humana DEMO</h4><Facts values={[
        ['Menú revisado', procurement.menu.label], ['Estado', procurement.menu.validation === 'validated_demo' ? 'Validado DEMO' : 'Bloqueado por datos faltantes'],
        ['Revisión de validación', procurement.menu.revision], ['Fecha de validación', at(procurement.menu.validatedAt)], ['Revisor', procurement.menu.validatedBy ?? 'Sin revisor'],
        ['Datos pendientes', procurement.menu.missingFacts.length ? procurement.menu.missingFacts.join(' · ') : 'Sin datos pendientes en esta muestra'], ['Huella del menú', procurement.menu.digest],
      ]} /><div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || procurement.menu.validation !== 'validated_demo'} onClick={() => void run({ step: 'build_purchase_list' })}>Preparar lista desde menú validado</button></div><SupplyEvidence evidence={procurement.menu.evidence} /></article>}
      {procurement.list && <article className="result-card" data-testid="supply-purchase-list"><h4>Lista de abastecimiento</h4><ListDetails list={procurement.list} /></article>}
      <h4>Opciones ficticias de abastecimiento</h4>{procurement.optionFixtures.map(fixture => <article className="task-card" key={fixture.id} data-testid={`supply-option-preview-${fixture.id}`}><OptionFixtureDetails option={fixture} list={procurement.list} /><div className="approval-actions"><button type="button" className="button button-secondary" disabled={disabled || procurement.list === null || procurement.menu?.validation !== 'validated_demo'} onClick={() => procurement.list && void run({ step: 'choose_purchase_option', optionFixtureId: fixture.id, listRevision: procurement.list.revision })}>Preparar opción con coste total</button></div></article>)}
      {procurement.options.map(option => <article className="result-card" key={option.id} data-testid={`supply-option-${option.id}`}><h4>{option.label}</h4><OptionDetails option={option} /><Facts values={[
        ['Estado de revisión', REVIEW[option.reviewStatus]], ['Fecha de decisión', at(option.reviewedAt)], ['Revisión humana vinculada', option.approvalId ?? 'Sin revisión vinculada'], ['Huella de la opción', option.digest],
      ]} /><p className="form-hint">Revisa ingredientes, cantidades, dirección, ventana, cargos y coste total. La revisión DEMO no hace un pedido.</p><div className="approval-actions"><button type="button" className="button button-primary" disabled={disabled || option.reviewStatus === 'stale' || option.missingFacts.length > 0 || option.totalCents === null || option.listRevision !== procurement.list?.revision || option.menuRevision !== procurement.menu?.revision || option.approvalId !== null} onClick={() => void run({ step: 'review_purchase', optionId: option.id, revision: option.revision })}>Preparar revisión de abastecimiento</button></div></article>)}
    </>}
  </section>;
}
