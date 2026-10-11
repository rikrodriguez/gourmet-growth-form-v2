import type { OfficeCommand } from '../contracts';
import { isSupplyOperation } from '../supply-contracts';
import type { SupplyCandidate, SupplyCaseState, SupplyMenu, SupplyMenuFixture, SupplyOperation, SupplyOperationResult, SupplyPurchaseList, SupplyPurchaseOption, SupplyPurchaseOptionFixture, SupplyPurchaseSnapshot, SupplyReviewContext, SupplyReviewStatus, SupplySelectionSnapshot, SupplyState, SupplyWindow, SupplyWorkflow } from '../supply-contracts';
import { getSupplyFixtures } from './supply-fixtures';
import type { DemoCaseId, OfficeState } from './state';
import { CASE_IDS, DEMO_ACTOR, OfficeError, canonical, currentTime, evidence, sha256 } from './state';

type SupplyOfficeState = OfficeState & { office: OfficeState['office'] & { supply?: SupplyState } };
const MAX_REVIEW_RECORDS = 1000;
const sourcingSteps = new Set<SupplyOperation['step']>(['queue_sourcing', 'ingest_digest', 'evaluate_candidate', 'verify_availability', 'approve_terms', 'select_candidate', 'assign_demo']);
const iso = (atMs: number) => new Date(currentTime(() => atMs)).toISOString();
const displayMoney = (cents: number | null, currency: 'USD' | null) => `${cents === null ? 'desconocido' : (cents / 100).toFixed(2)} ${currency ?? '(moneda desconocida)'}`;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => integer(value) && value > 0;
const revision = (value: unknown): value is number => positive(value) && value <= 1_000_000;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const windowValid = (window: SupplyWindow | null) => window !== null && date(window.startAt) && date(window.endAt) && Date.parse(window.startAt) < Date.parse(window.endAt);
const checkedCase = (state: OfficeState, caseId: string): DemoCaseId => {
  if (!(CASE_IDS as readonly string[]).includes(caseId) || !Object.hasOwn(state.office.cases, caseId)) throw new OfficeError('UNKNOWN_CASE', 404);
  return caseId as DemoCaseId;
};

export function parseSupplyOperation(raw: unknown): SupplyOperation {
  if (!isSupplyOperation(raw)) throw new OfficeError('INVALID_SUPPLY_OPERATION');
  return structuredClone(raw);
}

function acceptedSupplier(state: OfficeState, caseId: DemoCaseId, atMs: number) {
  const item = state.office.cases[caseId];
  const proof = item.supplierEvidence;
  return item.supplier === 'accepted' && proof !== null && proof.simulated === true
    && (proof.source === 'fixture:office-demo' || proof.source.startsWith('demo:'))
    && proof.reference.startsWith(`demo:${caseId}:`) && date(proof.at) && Date.parse(proof.at) <= atMs;
}

export function ensureSupplyWorkflow(state: OfficeState, atMs: number): void {
  currentTime(() => atMs);
  const office = (state as SupplyOfficeState).office;
  if (office.supply === undefined) office.supply = { schemaVersion: 1, cases: {}, assignments: {} };
  if (office.supply.schemaVersion !== 1 || !office.supply.cases || !office.supply.assignments) throw new OfficeError('INVALID_SUPPLY_STATE', 503);
  for (const caseId of CASE_IDS) {
    const fixtures = getSupplyFixtures(caseId, office.initializedAtMs);
    if (!Object.hasOwn(office.supply.cases, caseId)) office.supply.cases[caseId] = { event: fixtures.event, queue: null, digests: {}, candidates: {}, selections: {}, menu: null, list: null, selectedOptionId: null, options: {} };
    const row = office.supply.cases[caseId];
    const needed = office.cases[caseId].saleClosed === true && !acceptedSupplier(state, caseId, atMs);
    if (needed && row.queue === null) {
      const id = `supply-queue-${caseId}`;
      row.queue = { id, caseId, status: 'queued', reason: 'sold_without_accepted_supplier', createdAt: iso(office.initializedAtMs), updatedAt: iso(atMs), externalResolved: false, evidence: evidence(caseId, id, office.initializedAtMs, 'fixture:office-demo') };
    } else if (row.queue && row.queue.status !== (needed ? 'queued' : 'resolved_fixture')) {
      row.queue.status = needed ? 'queued' : 'resolved_fixture'; row.queue.updatedAt = iso(atMs);
    }
  }
  assertSupplyState(state);
}

// Validate only this optional aggregate; never recurse into assertOfficeState.
// JSON data cannot carry executable dependency getters or cyclic snapshots.
export function assertSupplyState(state: OfficeState): void {
  const supply = (state as SupplyOfficeState).office.supply;
  if (supply === undefined) return;
  const invalid = () => { throw new OfficeError('INVALID_SUPPLY_STATE', 503); };
  const ancestors = new Set<object>();
  const data = (value: unknown, depth = 0): void => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || depth > 20 || ancestors.has(value)) return invalid();
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 10_000 || array && keys.length !== value.length + 1) return invalid();
    ancestors.add(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !descriptor || !('value' in descriptor) || key !== 'length' && !descriptor.enumerable) return invalid();
      if (array && key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) return invalid();
      data(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
  };
  data(supply);
  if (supply.schemaVersion !== 1 || Object.keys(supply.cases).length !== CASE_IDS.length || CASE_IDS.some(id => !Object.hasOwn(supply.cases, id))) return invalid();
  for (const caseId of CASE_IDS) {
    const row = supply.cases[caseId];
    if (!row || row.event.caseId !== caseId || !windowValid(row.event.window) || row.event.revision !== 1 || !row.digests || !row.candidates || !row.selections || !row.options) return invalid();
    if (row.queue && (row.queue.caseId !== caseId || row.queue.externalResolved !== false || !['queued', 'resolved_fixture'].includes(row.queue.status))) return invalid();
    for (const [id, candidate] of Object.entries(row.candidates)) {
      if (candidate.id !== id || candidate.caseId !== caseId || !revision(candidate.revision) || candidate.externalHired !== false || !candidate.contact.endsWith('@invalid.test') || candidate.announcements.some(entry => entry.candidateId !== id)) return invalid();
      if (candidate.announcedRateCents !== null && !integer(candidate.announcedRateCents)) return invalid();
      if (!['eligible', 'rejected', null].includes(candidate.evaluation.verdict) || !['unknown', 'available', 'unavailable'].includes(candidate.availability.status)) return invalid();
    }
    for (const [id, selection] of Object.entries(row.selections)) {
      if (selection.id !== id || selection.caseId !== caseId || !revision(selection.revision) || !Object.hasOwn(row.candidates, selection.candidateId) || selection.digest !== selectionDigest(caseId, id, selection.revision, selection.snapshot)) return invalid();
    }
    for (const [id, option] of Object.entries(row.options)) {
      if (option.id !== id || option.caseId !== caseId || !revision(option.revision) || option.externalOrdered !== false || option.externalPaid !== false || option.externalReceived !== false) return invalid();
      if (option.totalCents !== null && !integer(option.totalCents)) return invalid();
    }
    if (row.selectedOptionId !== null && !Object.hasOwn(row.options, row.selectedOptionId)) return invalid();
  }
  for (const [id, assignment] of Object.entries(supply.assignments)) if (assignment.id !== id || !(CASE_IDS as readonly string[]).includes(assignment.caseId) || assignment.externalHired !== false || assignment.status !== 'assigned_demo' || !windowValid(assignment.window)) return invalid();
}

export function projectSupplyWorkflow(state: OfficeState, caseId: DemoCaseId, atMs: number): SupplyWorkflow {
  checkedCase(state, caseId);
  const copy = structuredClone(state) as SupplyOfficeState;
  ensureSupplyWorkflow(copy, atMs);
  const row = copy.office.supply!.cases[caseId];
  const fixtures = getSupplyFixtures(caseId, state.office.initializedAtMs);
  return structuredClone({
    mode: 'demo', event: row.event,
    sourcing: { queue: row.queue, digests: Object.values(row.digests), candidates: Object.values(row.candidates), selections: Object.values(row.selections), assignments: Object.values(copy.office.supply!.assignments).filter(assignment => assignment.caseId === caseId), digestFixtures: fixtures.digestFixtures, termsFixtures: fixtures.termsFixtures },
    procurement: { menu: row.menu, list: row.list, selectedOptionId: row.selectedOptionId, options: Object.values(row.options), menuFixtures: fixtures.menuFixtures, optionFixtures: fixtures.optionFixtures },
  });
}

function candidateFor(row: SupplyCaseState, candidateId: string, expectedRevision: number): SupplyCandidate {
  const candidate = Object.hasOwn(row.candidates, candidateId) ? row.candidates[candidateId] : undefined;
  if (!candidate) throw new OfficeError('SUPPLY_CANDIDATE_NOT_FOUND', 404);
  if (candidate.revision !== expectedRevision) throw new OfficeError('SUPPLY_REVISION_CONFLICT', 409);
  return candidate;
}
function invalidateCandidate(row: SupplyCaseState, candidate: SupplyCandidate) {
  for (const selection of Object.values(row.selections)) if (selection.candidateId === candidate.id) selection.reviewStatus = 'stale';
  candidate.revision += 1;
}
function invalidatePurchases(row: SupplyCaseState) {
  for (const option of Object.values(row.options)) option.reviewStatus = 'stale';
  row.selectedOptionId = null;
}
function candidateReady(row: SupplyCaseState, candidate: SupplyCandidate, atMs: number) {
  if (candidate.evaluation.verdict !== 'eligible' || candidate.evaluation.checkedAt === null) throw new OfficeError('SUPPLY_CANDIDATE_NOT_ELIGIBLE', 409);
  if (candidate.city !== row.event.city || candidate.coverage === null || !candidate.coverage.includes(row.event.coverage)) throw new OfficeError('SUPPLY_CANDIDATE_FACTS_MISSING', 409);
  if (candidate.availability.status !== 'available' || candidate.availability.checkedAt === null || canonical(candidate.availability.window) !== canonical(row.event.window)) throw new OfficeError('SUPPLY_AVAILABILITY_NOT_VERIFIED', 409);
  if (Date.parse(row.event.window.endAt) <= atMs) throw new OfficeError('SUPPLY_EVENT_WINDOW_EXPIRED', 409);
  if (!candidate.terms || !termsComplete(candidate.terms)) throw new OfficeError('SUPPLY_TERMS_NOT_APPROVED', 409);
}
const termsComplete = (terms: NonNullable<SupplyCandidate['terms']> | ReturnType<typeof getSupplyFixtures>['termsFixtures'][number]) => positive(terms.rateCents) && ['hour', 'event'].includes(terms.rateUnit ?? '') && positive(terms.quantity) && terms.currency === 'USD' && positive(terms.totalCents) && terms.totalCents === terms.rateCents * terms.quantity && typeof terms.conditions === 'string' && terms.conditions.length > 0;
const selectionDigest = (caseId: string, id: string, rev: number, snapshot: SupplySelectionSnapshot) => sha256({ kind: 'selection', caseId, id, revision: rev, snapshot });
function selectionContext(row: SupplyCaseState, id: string): Extract<SupplyReviewContext, { kind: 'selection' }> {
  const selection = row.selections[id];
  return structuredClone({ schemaVersion: 1, kind: 'selection', caseId: selection.caseId, selectionId: id, revision: selection.revision, digest: selection.digest, snapshot: selection.snapshot, evidence: selection.evidence });
}
function purchaseContext(row: SupplyCaseState, id: string): Extract<SupplyReviewContext, { kind: 'purchase' }> {
  const option = row.options[id];
  if (!option.snapshot) throw new OfficeError('SUPPLY_PURCHASE_NOT_REVIEWED', 409);
  return structuredClone({ schemaVersion: 1, kind: 'purchase', caseId: option.caseId, optionId: id, revision: option.revision, digest: option.digest, snapshot: option.snapshot, evidence: option.evidence });
}
function reviewRecord(state: OfficeState, context: SupplyReviewContext) {
  const supply = (state as SupplyOfficeState).office.supply;
  if (!supply || !Object.hasOwn(supply.cases, context.caseId)) throw new OfficeError('SUPPLY_REVIEW_NOT_FOUND', 404);
  const row = supply.cases[context.caseId];
  const record = context.kind === 'selection' ? row.selections[context.selectionId] : row.options[context.optionId];
  if (!record) throw new OfficeError('SUPPLY_REVIEW_NOT_FOUND', 404);
  const expected = context.kind === 'selection' ? selectionContext(row, context.selectionId) : purchaseContext(row, context.optionId);
  if (canonical(expected) !== canonical(context)) throw new OfficeError('SUPPLY_REVIEW_DIGEST_MISMATCH', 409);
  return { row, record };
}

function menuMissing(fixture: SupplyMenuFixture): string[] {
  const missing: string[] = [];
  if (!fixture.items.length) missing.push('menú');
  for (const item of fixture.items) {
    if (!positive(item.servings)) missing.push(`cantidad:${item.id}`);
    const recipe = fixture.recipes.find(row => row.id === item.recipeId);
    if (!recipe || !recipe.ingredients.length) { missing.push(`receta:${item.id}`); continue; }
    for (const ingredient of recipe.ingredients) if (!positive(ingredient.quantityPerServing) || !['g', 'unit'].includes(ingredient.unit ?? '')) missing.push(`cantidad-receta:${ingredient.id}`);
  }
  return [...new Set(missing)];
}
function optionBase(option: SupplyPurchaseOption): SupplyPurchaseSnapshot['option'] {
  const { approvalId: _approval, reviewStatus: _status, reviewedAt: _reviewed, snapshot: _snapshot, digest: _digest, ...base } = option;
  return structuredClone(base);
}
function purchaseMissing(option: SupplyPurchaseOption): string[] {
  const missing: string[] = [];
  if (!option.deliveryAddress) missing.push('dirección');
  if (!windowValid(option.deliveryWindow)) missing.push('ventana de entrega');
  if (option.currency !== 'USD') missing.push('moneda');
  if (!integer(option.totalCents) || !integer(option.itemsTotalCents) || !integer(option.deliveryFeeCents) || !integer(option.taxCents)) missing.push('coste total');
  if (option.substitutions === null) missing.push('sustituciones');
  if (!option.items.length) missing.push('artículos');
  for (const item of option.items) if (!positive(item.quantity) || item.unit === null || !integer(item.unitPriceCents) || !integer(item.lineTotalCents)) missing.push(`cantidad/precio:${item.id}`);
  return [...new Set(missing)];
}
function createOption(row: SupplyCaseState, fixture: SupplyPurchaseOptionFixture, caseId: DemoCaseId, atMs: number): SupplyPurchaseOption {
  const list = row.list!;
  const id = `supply-option-${sha256({ caseId, fixtureId: fixture.id, listDigest: list.digest }).slice(0, 24)}`;
  const items = list.items.map(item => {
    const price = fixture.prices.find(price => price.itemId === item.id)?.unitPriceCents ?? null;
    const total = item.quantity !== null && integer(price) && Number.isSafeInteger(item.quantity * price) ? item.quantity * price : null;
    return { ...structuredClone(item), unitPriceCents: price, lineTotalCents: total };
  });
  const sum = items.every(item => item.lineTotalCents !== null) ? items.reduce((total, item) => total + item.lineTotalCents!, 0) : null;
  const itemsTotalCents = integer(sum) ? sum : null;
  const total = itemsTotalCents !== null && integer(fixture.deliveryFeeCents) && integer(fixture.taxCents) ? itemsTotalCents + fixture.deliveryFeeCents + fixture.taxCents : null;
  const option: SupplyPurchaseOption = {
    id, caseId, fixtureId: fixture.id, revision: 1, menuRevision: row.menu!.revision, listRevision: list.revision,
    label: fixture.label, service: fixture.service, deliveryAddress: fixture.deliveryAddress, deliveryWindow: structuredClone(fixture.deliveryWindow), items,
    itemsTotalCents, deliveryFeeCents: fixture.deliveryFeeCents, taxCents: fixture.taxCents, totalCents: integer(total) ? total : null, currency: fixture.currency, substitutions: fixture.substitutions,
    missingFacts: [], externalOrdered: false, externalPaid: false, externalReceived: false, approvalId: null, reviewStatus: 'pending', reviewedAt: null, snapshot: null, digest: '', evidence: evidence(caseId, id, atMs),
  };
  option.missingFacts = purchaseMissing(option);
  option.digest = sha256(optionBase(option));
  return option;
}

export function applySupplyOperation(state: OfficeState, command: OfficeCommand, atMs: number): SupplyOperationResult {
  const operation = parseSupplyOperation((command as OfficeCommand & { supply?: unknown }).supply);
  const sourcing = sourcingSteps.has(operation.step);
  if (command.action !== 'draft' || command.functionId !== (sourcing ? 'suppliers' : 'logistics')) throw new OfficeError('INVALID_SUPPLY_OPERATION');
  const caseId = checkedCase(state, command.caseId);
  if (sourcing && state.office.cases[caseId].saleClosed !== true) throw new OfficeError('SALE_NOT_CLOSED', 403);
  ensureSupplyWorkflow(state, atMs);
  const supply = (state as SupplyOfficeState).office.supply!;
  const row = supply.cases[caseId];
  const fixtures = getSupplyFixtures(caseId, state.office.initializedAtMs);
  const done = (title: string, detail: string, status: SupplyOperationResult['status'] = 'completed'): SupplyOperationResult => ({ title: `${title} · DEMO`, detail: `DEMO — ${detail} Sin contacto, contratación, pedido, cobro ni entrega externos.`, status });
  if (operation.step === 'queue_sourcing') return row.queue?.status === 'queued' ? done('Sourcing en cola humana', 'Venta cerrada; falta aceptación verificable de chef. La cola permanece pendiente hasta evidencia independiente.', 'queued') : done('Proveedor aceptado en fixture', 'No hace falta abrir una nueva cola; la aceptación existente conserva su propia evidencia.');
  if (operation.step === 'ingest_digest') {
    const fixture = fixtures.digestFixtures.find(fixture => fixture.id === operation.fixtureId);
    if (!fixture) throw new OfficeError('SUPPLY_FIXTURE_NOT_FOUND', 404);
    if (Object.hasOwn(row.digests, fixture.id)) return done('Digest ya incorporado', 'Se conservan las entradas y candidatos existentes; no se reinicia su revisión humana.');
    const ids = new Set(fixture.entries.map(entry => entry.candidateId));
    row.digests[fixture.id] = { ...structuredClone(fixture), extractedCount: fixture.entries.length, uniqueCount: ids.size, duplicateCount: fixture.entries.length - ids.size, countMismatch: fixture.announcedCount !== fixture.entries.length || fixture.announcedCount !== ids.size, ingestedAt: iso(atMs) };
    for (const candidateId of ids) {
      const announcements = fixture.entries.filter(entry => entry.candidateId === candidateId);
      const first = announcements[0];
      if (Object.hasOwn(row.candidates, candidateId)) { const candidate = row.candidates[candidateId]; candidate.announcements.push(...structuredClone(announcements)); invalidateCandidate(row, candidate); candidate.evaluation = { verdict: null, checkedAt: null, checkedBy: null }; candidate.availability = { status: 'unknown', window: null, checkedAt: null, checkedBy: null }; candidate.terms = null; continue; }
      row.candidates[candidateId] = { id: candidateId, caseId, revision: 1, label: first.label, contact: first.contact, source: first.source, sourceLink: first.sourceLink, readAt: first.readAt, city: first.city, coverage: structuredClone(first.coverage), announcedRateCents: first.announcedRateCents, announcedRateUnit: first.announcedRateUnit, currency: first.currency, announcements: structuredClone(announcements), evaluation: { verdict: null, checkedAt: null, checkedBy: null }, availability: { status: 'unknown', window: null, checkedAt: null, checkedBy: null }, terms: null, externalHired: false, evidence: structuredClone(fixture.evidence) };
    }
    return done('Digest incorporado con discrepancia visible', `Anunciados ${fixture.announcedCount}; extraídos ${fixture.entries.length}; únicos ${ids.size}; duplicados ${fixture.entries.length - ids.size}. Todas las entradas originales permanecen visibles; el precio anunciado no acredita condiciones acordadas.`);
  }
  if (['evaluate_candidate', 'verify_availability', 'approve_terms', 'select_candidate'].includes(operation.step)) {
    const input = operation as Extract<SupplyOperation, { candidateId: string }>;
    const candidate = candidateFor(row, input.candidateId, input.revision);
    if (operation.step === 'evaluate_candidate') {
      if (operation.verdict === 'eligible' && (candidate.city !== row.event.city || candidate.coverage === null || !candidate.coverage.includes(row.event.coverage))) throw new OfficeError('SUPPLY_CANDIDATE_FACTS_MISSING', 409);
      invalidateCandidate(row, candidate);
      candidate.evaluation = { verdict: operation.verdict, checkedAt: iso(atMs), checkedBy: DEMO_ACTOR };
      candidate.availability = { status: 'unknown', window: null, checkedAt: null, checkedBy: null }; candidate.terms = null;
      return done('Evaluación humana registrada', `${candidate.label}: ${operation.verdict === 'eligible' ? 'elegible' : 'rechazado'} en revisión ${candidate.revision}; disponibilidad y condiciones siguen pendientes.`);
    }
    if (operation.step === 'verify_availability') {
      if (candidate.evaluation.verdict !== 'eligible') throw new OfficeError('SUPPLY_CANDIDATE_NOT_ELIGIBLE', 409);
      if (Date.parse(row.event.window.endAt) <= atMs) throw new OfficeError('SUPPLY_EVENT_WINDOW_EXPIRED', 409);
      invalidateCandidate(row, candidate);
      candidate.availability = { status: operation.status, window: structuredClone(row.event.window), checkedAt: iso(atMs), checkedBy: DEMO_ACTOR }; candidate.terms = null;
      return done('Disponibilidad humana registrada', `${candidate.label}: ${operation.status === 'available' ? 'disponible' : 'no disponible'} para la ventana exacta del evento. Es una elección sintética; no confirma disponibilidad externa.`);
    }
    if (operation.step === 'approve_terms') {
      if (candidate.evaluation.verdict !== 'eligible') throw new OfficeError('SUPPLY_CANDIDATE_NOT_ELIGIBLE', 409);
      if (candidate.availability.status !== 'available' || canonical(candidate.availability.window) !== canonical(row.event.window)) throw new OfficeError('SUPPLY_AVAILABILITY_NOT_VERIFIED', 409);
      const fixture = fixtures.termsFixtures.find(fixture => fixture.id === operation.termsFixtureId);
      if (!fixture) throw new OfficeError('SUPPLY_FIXTURE_NOT_FOUND', 404);
      if (fixture.candidateId !== candidate.id) throw new OfficeError('SUPPLY_TERMS_CANDIDATE_MISMATCH', 409);
      if (!termsComplete(fixture)) return done('Condiciones incompletas', 'Faltan importe, unidad, cantidad, moneda o condiciones; no se registra aprobación de condiciones.', 'blocked');
      invalidateCandidate(row, candidate);
      candidate.terms = { ...structuredClone(fixture), checkedAt: iso(atMs), checkedBy: DEMO_ACTOR };
      return done('Condiciones humanas registradas', `Anunciado ${displayMoney(candidate.announcedRateCents, candidate.currency)}/${candidate.announcedRateUnit ?? 'unidad desconocida'}; tarifa acordada DEMO ${displayMoney(fixture.rateCents, fixture.currency)}/${fixture.rateUnit}, cantidad ${fixture.quantity}, total ${displayMoney(fixture.totalCents, fixture.currency)}; permanece separado del precio anunciado.`);
    }
    candidateReady(row, candidate, atMs);
    if (row.queue?.status !== 'queued') throw new OfficeError('SUPPLY_SOURCING_NOT_REQUIRED', 409);
    const snapshot: SupplySelectionSnapshot = { candidate: structuredClone(candidate), event: structuredClone(row.event), terms: structuredClone(candidate.terms!) };
    const id = `supply-selection-${sha256({ caseId, snapshot }).slice(0, 24)}`;
    if (!Object.hasOwn(row.selections, id) && Object.keys(row.selections).length >= MAX_REVIEW_RECORDS) throw new OfficeError('SUPPLY_RECORD_LIMIT', 409);
    if (!Object.hasOwn(row.selections, id)) row.selections[id] = { id, caseId, candidateId: candidate.id, revision: 1, digest: selectionDigest(caseId, id, 1, snapshot), snapshot, approvalId: null, reviewStatus: 'pending', reviewedAt: null, assignedDemo: false, evidence: evidence(caseId, id, atMs) };
    const context = selectionContext(row, id);
    return { ...done('Selección lista para revisión', 'Identidad, revisión, ciudad/cobertura, disponibilidad, ventana y condiciones exactas vinculadas; aprobar no asigna ni contrata.', 'awaiting_approval'), review: { title: 'Selección de chef · revisión interna DEMO', body: `DEMO — Selección de ${candidate.label} (${candidate.id}); caso ${caseId}.\nCiudad/cobertura: ${row.event.city} / ${row.event.coverage}.\nEvento: ${row.event.window.startAt} → ${row.event.window.endAt}.\nRevisión del candidato: ${candidate.revision}. Fuente: ${candidate.source}; ${candidate.sourceLink}; leído ${candidate.readAt}.\nAnunciado: ${displayMoney(candidate.announcedRateCents, candidate.currency)}/${candidate.announcedRateUnit ?? 'unidad desconocida'}.\nCondiciones humanas: ${displayMoney(candidate.terms!.rateCents, candidate.terms!.currency)}/${candidate.terms!.rateUnit}; cantidad ${candidate.terms!.quantity}; total ${displayMoney(candidate.terms!.totalCents, candidate.terms!.currency)}. ${candidate.terms!.conditions}\nAprobar sólo registra la revisión. Asignación DEMO requiere un paso explícito posterior; no hay contratación ni aceptación externa.`, context } };
  }
  if (operation.step === 'assign_demo') {
    const selection = Object.hasOwn(row.selections, operation.selectionId) ? row.selections[operation.selectionId] : undefined;
    if (!selection) throw new OfficeError('SUPPLY_SELECTION_NOT_FOUND', 404);
    if (selection.revision !== operation.revision) throw new OfficeError('SUPPLY_REVISION_CONFLICT', 409);
    const context = selectionContext(row, selection.id);
    assertSupplyReviewCurrent(state, context, caseId, atMs);
    const link = selection.approvalId ? state.office.approvals[selection.approvalId] : undefined;
    if (selection.reviewStatus !== 'approved_demo' || !link || link.status !== 'approved_demo' || canonical((link as typeof link & { supplyContext?: SupplyReviewContext }).supplyContext) !== canonical(context) || !link.coreApprovalId || state.approvals[link.coreApprovalId]?.valid !== true) throw new OfficeError('SUPPLY_REVIEW_NOT_APPROVED', 409);
    const id = `supply-assignment-${sha256(selection.id).slice(0, 24)}`;
    if (Object.hasOwn(supply.assignments, id)) return done('Asignación DEMO existente', 'La reserva local del mismo candidato/evento ya está registrada; no se duplica.');
    if (Object.values(supply.assignments).some(assignment => assignment.caseId === caseId)) throw new OfficeError('SUPPLY_CASE_ALREADY_ASSIGNED', 409);
    const window = row.event.window;
    const overlap = Object.values(supply.assignments).some(assignment => assignment.candidateId === selection.candidateId && Date.parse(assignment.window.startAt) < Date.parse(window.endAt) && Date.parse(window.startAt) < Date.parse(assignment.window.endAt));
    if (overlap) throw new OfficeError('SUPPLY_ASSIGNMENT_OVERLAP', 409);
    supply.assignments[id] = { id, caseId, candidateId: selection.candidateId, selectionId: selection.id, selectionRevision: selection.revision, approvalId: selection.approvalId!, window: structuredClone(window), assignedAt: iso(atMs), status: 'assigned_demo', externalHired: false, evidence: evidence(caseId, id, atMs) };
    selection.assignedDemo = true;
    return done('Asignación DEMO registrada', 'Reserva local exacta sin solapamientos. La aceptación del proveedor y la incidencia de pago siguen independientes; no se acredita contratación real.');
  }
  if (operation.step === 'validate_menu') {
    const fixture = fixtures.menuFixtures.find(fixture => fixture.id === operation.fixtureId);
    if (!fixture) throw new OfficeError('SUPPLY_FIXTURE_NOT_FOUND', 404);
    const missingFacts = menuMissing(fixture);
    const rev = (row.menu?.revision ?? 0) + 1;
    invalidatePurchases(row); row.list = null;
    const menu: SupplyMenu = { ...structuredClone(fixture), revision: rev, digest: sha256({ fixture, revision: rev }), validation: missingFacts.length ? 'blocked' : 'validated_demo', validatedAt: missingFacts.length ? null : iso(atMs), validatedBy: missingFacts.length ? null : DEMO_ACTOR, missingFacts };
    row.menu = menu;
    return missingFacts.length ? done('Menú pendiente', `Faltan ${missingFacts.join(', ')}. No se valida ni construye una lista apta para compra.`, 'blocked') : done('Menú validado por humano', `Menú y recetas completos, cantidades explícitas; revisión ${rev}. Falta construir y revisar lista/opción de compra.`);
  }
  if (operation.step === 'build_purchase_list') {
    if (!row.menu || row.menu.validation !== 'validated_demo' || menuMissing(row.menu).length || row.menu.validatedAt === null) return done('Lista bloqueada', 'Menú/recetas/cantidades sin validación humana completa. Los datos faltantes no equivalen a cero.', 'blocked');
    const items = new Map<string, SupplyPurchaseList['items'][number]>();
    for (const item of row.menu.items) {
      const recipe = row.menu.recipes.find(recipe => recipe.id === item.recipeId)!;
      for (const ingredient of recipe.ingredients) {
        const quantity = item.servings! * ingredient.quantityPerServing!;
        if (!positive(quantity)) throw new OfficeError('SUPPLY_QUANTITY_INVALID', 409);
        const old = items.get(ingredient.id);
        if (old && old.unit !== ingredient.unit) throw new OfficeError('SUPPLY_QUANTITY_INVALID', 409);
        const sum = quantity + (old?.quantity ?? 0);
        if (!positive(sum)) throw new OfficeError('SUPPLY_QUANTITY_INVALID', 409);
        items.set(ingredient.id, { id: ingredient.id, label: ingredient.label, quantity: sum, unit: ingredient.unit });
      }
    }
    if (row.list?.menuDigest === row.menu.digest) return done('Lista existente', 'Se conserva la misma lista revisionada para el menú validado; no se reinicia una revisión de compra.');
    // Menu validation invalidates the current list, but its next revision must
    // remain monotonic so an old client listRevision can never target new facts.
    const rev = Math.max(row.menu.revision, (row.list?.revision ?? 0) + 1);
    const id = `supply-list-${caseId}`;
    const content = { id, caseId, revision: rev, menuRevision: row.menu.revision, menuDigest: row.menu.digest, items: [...items.values()] };
    invalidatePurchases(row);
    row.list = { ...content, digest: sha256(content), createdAt: iso(atMs), evidence: evidence(caseId, `${id}-revision-${rev}`, atMs) };
    return done('Lista de compra preparada', `Cantidades derivadas de recetas/porciones humanas, revisión ${rev}. No hay pedido ni existencia/precio real comprobados.`);
  }
  if (operation.step === 'choose_purchase_option') {
    if (!row.menu || row.menu.validation !== 'validated_demo' || !row.list) throw new OfficeError('SUPPLY_MENU_NOT_VALIDATED', 409);
    if (operation.listRevision !== row.list.revision) throw new OfficeError('SUPPLY_REVISION_CONFLICT', 409);
    const fixture = fixtures.optionFixtures.find(fixture => fixture.id === operation.optionFixtureId);
    if (!fixture) throw new OfficeError('SUPPLY_FIXTURE_NOT_FOUND', 404);
    const selected = row.selectedOptionId ? row.options[row.selectedOptionId] : undefined;
    if (selected && selected.fixtureId === fixture.id && selected.listRevision === row.list.revision && selected.menuRevision === row.menu.revision && selected.reviewStatus !== 'stale') return selected.missingFacts.length ? done('Opción de compra incompleta', `Faltan ${selected.missingFacts.join(', ')}. No puede abrirse una aprobación.`, 'blocked') : done('Opción de compra existente', 'Se conserva la opción y su revisión humana vigente; no se duplica el borrador.');
    const candidate = createOption(row, fixture, caseId, atMs);
    if (row.options[candidate.id]?.reviewStatus === 'stale') {
      // Keep prior records intact for historical rejection/cancellation. A new
      // human choice gets a new record, never restores an obsolete approval.
      candidate.revision = Math.max(...Object.values(row.options).filter(option => option.fixtureId === fixture.id && option.menuRevision === row.menu!.revision && option.listRevision === row.list!.revision).map(option => option.revision)) + 1;
      candidate.id = `supply-option-${sha256({ caseId, fixtureId: fixture.id, listDigest: row.list.digest, revision: candidate.revision }).slice(0, 24)}`;
      candidate.evidence = evidence(caseId, `${candidate.id}-revision-${candidate.revision}`, atMs);
      candidate.digest = sha256(optionBase(candidate));
    }
    if (!Object.hasOwn(row.options, candidate.id) && Object.keys(row.options).length >= MAX_REVIEW_RECORDS) throw new OfficeError('SUPPLY_RECORD_LIMIT', 409);
    if (row.selectedOptionId !== candidate.id) invalidatePurchases(row);
    if (!Object.hasOwn(row.options, candidate.id)) row.options[candidate.id] = candidate;
    row.selectedOptionId = candidate.id;
    const option = row.options[candidate.id];
    return option.missingFacts.length ? done('Opción de compra incompleta', `Faltan ${option.missingFacts.join(', ')}. No puede abrirse una aprobación.`, 'blocked') : done('Opción de compra elegida', `Dirección/ventana/cantidades/moneda/total y sustituciones explícitas; artículos ${displayMoney(option.itemsTotalCents, option.currency)}, entrega ${displayMoney(option.deliveryFeeCents, option.currency)}, impuestos ${displayMoney(option.taxCents, option.currency)}, total ${displayMoney(option.totalCents, option.currency)} en fixture. Falta revisión humana exacta.`);
  }
  if (operation.step !== 'review_purchase') throw new OfficeError('INVALID_SUPPLY_OPERATION');
  const option = Object.hasOwn(row.options, operation.optionId) ? row.options[operation.optionId] : undefined;
  if (!option) throw new OfficeError('SUPPLY_PURCHASE_OPTION_NOT_FOUND', 404);
  if (option.revision !== operation.revision) throw new OfficeError('SUPPLY_REVISION_CONFLICT', 409);
  if (row.selectedOptionId !== option.id || !row.menu || !row.list || row.menu.revision !== option.menuRevision || row.list.revision !== option.listRevision) throw new OfficeError('SUPPLY_REVIEW_STALE', 409);
  option.missingFacts = purchaseMissing(option);
  if (option.missingFacts.length) return done('Revisión de compra bloqueada', `Faltan ${option.missingFacts.join(', ')}. No se crea aprobación ni pedido.`, 'blocked');
  if (Date.parse(option.deliveryWindow!.endAt) <= atMs) return done('Ventana de compra vencida', 'La ventana de entrega ya terminó. No se crea aprobación ni pedido.', 'blocked');
  if (!option.snapshot) {
    option.snapshot = { menu: structuredClone(row.menu), list: structuredClone(row.list), option: optionBase(option) };
    option.digest = sha256({ kind: 'purchase', caseId, id: option.id, revision: option.revision, snapshot: option.snapshot });
  }
  const context = purchaseContext(row, option.id);
  return { ...done('Compra lista para revisión interna', 'Menú, recetas, lista, opción, revisiones, dirección, ventana, cantidades, moneda y total quedan vinculados. Aprobar no compra, paga ni acredita recepción.', 'awaiting_approval'), review: { title: 'Lista y opción de compra · revisión interna DEMO', body: `DEMO — Revisión interna de compra para ${caseId}.\nMenú revisión ${option.menuRevision}; lista revisión ${option.listRevision}; opción revisión ${option.revision}.\nServicio: ${option.service}; dirección: ${option.deliveryAddress}.\nVentana: ${option.deliveryWindow!.startAt} → ${option.deliveryWindow!.endAt}.\n${option.items.map(item => `${item.label}: ${item.quantity} ${item.unit}; precio unitario ${displayMoney(item.unitPriceCents, option.currency)}/${item.unit ?? 'unidad desconocida'}; subtotal ${displayMoney(item.lineTotalCents, option.currency)}`).join('\n')}\nArtículos ${displayMoney(option.itemsTotalCents, option.currency)}; entrega ${displayMoney(option.deliveryFeeCents, option.currency)}; impuestos ${displayMoney(option.taxCents, option.currency)}; total ${displayMoney(option.totalCents, option.currency)}.\nSustituciones: ${option.substitutions}.\nSólo revisión humana interna. No hay capacidad para ejecutar pedidos, pagos ni recepción y no se atribuyen costes/stock/entrega a una cuenta real.`, context } };
}

export function bindSupplyReview(state: OfficeState, context: SupplyReviewContext, approvalId: string): void {
  const { record } = reviewRecord(state, context);
  if (record.approvalId !== null && record.approvalId !== approvalId) throw new OfficeError('SUPPLY_REVIEW_ALREADY_BOUND', 409);
  record.approvalId = approvalId;
}

export function assertSupplyReviewCurrent(state: OfficeState, context: SupplyReviewContext, caseId: DemoCaseId, atMs: number): void {
  currentTime(() => atMs);
  if (context.schemaVersion !== 1 || context.caseId !== caseId || !['selection', 'purchase'].includes(context.kind)) throw new OfficeError('SUPPLY_REVIEW_DIGEST_MISMATCH', 409);
  const { row, record } = reviewRecord(state, context);
  if (record.reviewStatus === 'stale') throw new OfficeError('SUPPLY_REVIEW_STALE', 409);
  if (context.kind === 'selection') {
    if (state.office.cases[caseId].saleClosed !== true) throw new OfficeError('SALE_NOT_CLOSED', 403);
    const candidate = row.candidates[context.snapshot.candidate.id];
    if (!candidate) throw new OfficeError('SUPPLY_REVIEW_STALE', 409);
    candidateReady(row, candidate, atMs);
    const current: SupplySelectionSnapshot = { candidate, event: row.event, terms: candidate.terms! };
    if (canonical(current) !== canonical(context.snapshot)) throw new OfficeError('SUPPLY_REVIEW_STALE', 409);
  } else {
    const option = row.options[context.optionId];
    if (row.selectedOptionId !== option.id || !row.menu || !row.list || row.menu.validation !== 'validated_demo' || purchaseMissing(option).length) throw new OfficeError('SUPPLY_REVIEW_STALE', 409);
    if (Date.parse(option.deliveryWindow!.endAt) <= atMs) throw new OfficeError('SUPPLY_PURCHASE_WINDOW_EXPIRED', 409);
    const current: SupplyPurchaseSnapshot = { menu: row.menu, list: row.list, option: optionBase(option) };
    if (canonical(current) !== canonical(context.snapshot)) throw new OfficeError('SUPPLY_REVIEW_STALE', 409);
  }
}

export function recordSupplyReviewDecision(state: OfficeState, context: SupplyReviewContext, status: Exclude<SupplyReviewStatus, 'pending' | 'stale'>, atMs: number): void {
  if (!['approved_demo', 'rejected_demo', 'cancelled_demo'].includes(status)) throw new OfficeError('INVALID_SUPPLY_OPERATION');
  const { record } = reviewRecord(state, context);
  if (status === 'approved_demo') assertSupplyReviewCurrent(state, context, context.caseId as DemoCaseId, atMs);
  if (record.approvalId === null) throw new OfficeError('SUPPLY_REVIEW_NOT_FOUND', 404);
  record.reviewStatus = status; record.reviewedAt = iso(atMs);
}
