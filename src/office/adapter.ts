import type { AreaId, CommercialThread, DataMode, Evidence, FunctionId, OfficeCase, OfficeCommand, OfficeSnapshot, WorkStatus } from './contracts';
import { isSupplyOperation } from './supply-contracts';
import type * as Supply from './supply-contracts';

export type OfficeErrorCode = 'unauthorized' | 'forbidden' | 'offline' | 'incompatible' | 'conflict' | 'validation';
const ERROR_MESSAGES: Record<OfficeErrorCode, string> = {
  unauthorized: 'Se requiere una sesión staff vigente.',
  forbidden: 'Esta sesión o acción no tiene permiso para la oficina.',
  offline: 'Sin conexión con el servicio. No se han confirmado cambios.',
  incompatible: 'La respuesta no cumple el contrato de la oficina; no se muestran datos sin verificar.',
  conflict: 'La revisión o la acción cambió. Actualiza el caso antes de volver a intentarlo.',
  validation: 'La acción contiene datos inválidos. Revisa el texto y la revisión seleccionada.',
};

export class OfficeReadError extends Error {
  readonly code: OfficeErrorCode;
  constructor(code: OfficeErrorCode) { super(ERROR_MESSAGES[code]); this.name = 'OfficeReadError'; this.code = code; }
}

const AREAS: AreaId[] = ['sales', 'coordination', 'kitchen', 'finance', 'direction'];
const FUNCTIONS: FunctionId[] = ['sales', 'proposals', 'coordination', 'logistics', 'suppliers', 'finance', 'quality', 'marketing', 'talent'];
const STATUSES: WorkStatus[] = ['queued', 'running', 'awaiting_approval', 'blocked', 'completed', 'failed', 'stale'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
type RecordValue = Record<string, unknown>;
function bad(): never { throw new OfficeReadError('incompatible'); }
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) bad();
  }
  return value as RecordValue;
}
function keys(value: RecordValue, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) bad();
}
function string(value: unknown, max = 4000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) bad();
  return value;
}
function id(value: unknown): string { const result = string(value, 128); if (!ID.test(result)) bad(); return result; }
function bool(value: unknown): boolean { if (typeof value !== 'boolean') bad(); return value; }
function nullableBool(value: unknown): boolean | null { return value === null ? null : bool(value); }
function date(value: unknown): string {
  const result = string(value, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result)) bad();
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed)) bad();
  const normalized = new Date(parsed).toISOString();
  if (normalized !== result && normalized.replace('.000Z', 'Z') !== result) bad();
  return result;
}
function nullableDate(value: unknown): string | null { return value === null ? null : date(value); }
function choice<T extends string>(value: unknown, values: readonly T[]): T { if (!values.includes(value as T)) bad(); return value as T; }
function evidence(value: unknown, mode: DataMode, caseId: string): Evidence {
  const item = record(value); keys(item, ['source', 'at', 'simulated', 'reference']);
  const result = { source: string(item.source, 128), at: date(item.at), simulated: bool(item.simulated), reference: string(item.reference, 512) };
  if (result.simulated !== (mode === 'demo')) bad();
  if (mode === 'demo' && !result.reference.startsWith(`demo:${caseId}:`)) bad();
  if (mode === 'demo' && !['fixture:office-demo', 'demo:office-command', 'demo:scripted-chat'].includes(result.source)) bad();
  if (mode === 'live' && !result.reference.startsWith(`growth_v2:lead:${caseId}:`)) bad();
  return result;
}
function nullableEvidence(value: unknown, mode: DataMode, caseId: string): Evidence | null { return value === null ? null : evidence(value, mode, caseId); }
function collection<T extends { id: string }>(value: unknown, map: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 1000) bad();
  const mapped = value.map(map);
  if (new Set(mapped.map(item => item.id)).size !== mapped.length) bad();
  return mapped;
}
function base(item: RecordValue, mode: DataMode, caseId: string) {
  return { id: id(item.id), functionId: choice(item.functionId, FUNCTIONS), evidence: evidence(item.evidence, mode, caseId) };
}
function commercialThread(value: unknown, mode: DataMode, caseId: string): CommercialThread {
  const item = record(value);
  keys(item, ['schemaVersion', 'id', 'caseId', 'revision', 'digest', 'subject', 'recipient', 'messages', 'references', 'evidence']);
  if (mode !== 'demo' || item.schemaVersion !== 1 || item.caseId !== caseId || !Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || (item.revision as number) > 1_000_000 || !DIGEST.test(string(item.digest, 64))) bad();
  const recipient = string(item.recipient, 300);
  if (!/^[^@\s]+@invalid\.test$/.test(recipient)) bad();
  if (!Array.isArray(item.messages) || !item.messages.length || item.messages.length > 20 || !Array.isArray(item.references) || !item.references.length || item.references.length > 10) bad();
  return {
    schemaVersion: 1, id: id(item.id), caseId, revision: item.revision as number, digest: item.digest as string,
    subject: string(item.subject, 200), recipient, evidence: evidence(item.evidence, mode, caseId),
    messages: collection(item.messages, value => {
      const row = record(value); keys(row, ['id', 'author', 'text', 'at']);
      return { id: id(row.id), author: string(row.author, 100), text: string(row.text, 2000), at: date(row.at) };
    }),
    references: collection(item.references, value => {
      const row = record(value); keys(row, ['id', 'source', 'status', 'label', 'detail', 'evidence']);
      const status = choice(row.status, ['simulated', 'missing']);
      const ev = nullableEvidence(row.evidence, mode, caseId);
      if ((status === 'missing') !== (ev === null)) bad();
      return { id: id(row.id), source: choice(row.source, ['fixture', 'gmail', 'monday']), status, label: string(row.label, 200), detail: string(row.detail, 1000), evidence: ev };
    }),
  };
}

// Supply records are synthetic, case-owned facts. Rebuild each object from an
// explicit field list before it can reach the dashboard or an approval card.
function supplyId(value: unknown): string {
  const result = id(value);
  if (result.length > 96 || ['__proto__', 'prototype', 'constructor'].includes(result)) bad();
  return result;
}
function number(value: unknown, minimum = 0, integer = false, maximum = 1_000_000_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) bad();
  return value;
}
function revision(value: unknown): number { return number(value, 1, true, 1_000_000); }
function digest(value: unknown): string { const result = string(value, 64); if (!DIGEST.test(result)) bad(); return result; }
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function strings(value: unknown, maximum = 1000): string[] {
  if (!Array.isArray(value) || value.length > maximum) bad();
  return value.map(item => string(item, 1000));
}
function supplyEvidence(value: unknown, caseId: string): Evidence { return evidence(value, 'demo', caseId); }
function falseFact(value: unknown): false { if (value !== false) bad(); return false; }
function supplyWindow(value: unknown): Supply.SupplyWindow {
  const item = record(value); keys(item, ['startAt', 'endAt']);
  const result = { startAt: date(item.startAt), endAt: date(item.endAt) };
  if (Date.parse(result.startAt) >= Date.parse(result.endAt)) bad();
  return result;
}
function syntheticContact(value: unknown): string {
  const result = string(value, 300);
  if (!/^[A-Za-z0-9._:+-]+@invalid\.test$/.test(result)) bad();
  return result;
}
function syntheticSourceLink(value: unknown): string {
  const result = string(value, 1000);
  let parsed: URL;
  try { parsed = new URL(result); } catch { bad(); }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.invalid.test') || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) bad();
  return result;
}
const SUPPLY_SOURCES = ['facebook_marketplace', 'facebook_groups', 'outreach_forms', 'meetachef'] as const;
const SUPPLY_REVIEW_STATUSES = ['pending', 'approved_demo', 'rejected_demo', 'cancelled_demo', 'stale'] as const;
function supplyEvent(value: unknown, caseId: string): Supply.SyntheticSupplyEvent {
  const item = record(value); keys(item, ['id', 'caseId', 'revision', 'city', 'coverage', 'window', 'evidence']);
  if (item.caseId !== caseId || item.revision !== 1) bad();
  return { id: supplyId(item.id), caseId, revision: 1, city: string(item.city, 200), coverage: string(item.coverage, 500), window: supplyWindow(item.window), evidence: supplyEvidence(item.evidence, caseId) };
}
function supplyAnnouncement(value: unknown): Supply.SupplyCandidateAnnouncement {
  const item = record(value); keys(item, ['id', 'candidateId', 'label', 'contact', 'source', 'sourceLink', 'readAt', 'city', 'coverage', 'announcedRateCents', 'announcedRateUnit', 'currency']);
  return { id: supplyId(item.id), candidateId: supplyId(item.candidateId), label: string(item.label, 200), contact: syntheticContact(item.contact), source: choice(item.source, SUPPLY_SOURCES), sourceLink: syntheticSourceLink(item.sourceLink), readAt: date(item.readAt), city: nullable(item.city, value => string(value, 200)), coverage: nullable(item.coverage, value => strings(value, 20)), announcedRateCents: nullable(item.announcedRateCents, value => number(value, 0, true)), announcedRateUnit: nullable(item.announcedRateUnit, value => choice(value, ['hour', 'event'])), currency: nullable(item.currency, value => choice(value, ['USD'])) };
}
function supplyDigestFixture(value: unknown, caseId: string, optional: string[] = []): Supply.SupplyDigestFixture {
  const item = record(value); keys(item, ['id', 'label', 'announcedCount', 'entries', 'evidence'], optional);
  return { id: supplyId(item.id), label: string(item.label, 200), announcedCount: number(item.announcedCount, 0, true, 1000), entries: collection(item.entries, supplyAnnouncement), evidence: supplyEvidence(item.evidence, caseId) };
}
function supplyDigestRecord(value: unknown, caseId: string): Supply.SupplyDigestRecord {
  const item = record(value);
  const fixture = supplyDigestFixture(item, caseId, ['extractedCount', 'uniqueCount', 'duplicateCount', 'countMismatch', 'ingestedAt']);
  keys(item, [...Object.keys(fixture), 'extractedCount', 'uniqueCount', 'duplicateCount', 'countMismatch', 'ingestedAt']);
  const result = { ...fixture, extractedCount: number(item.extractedCount, 0, true, 1000), uniqueCount: number(item.uniqueCount, 0, true, 1000), duplicateCount: number(item.duplicateCount, 0, true, 1000), countMismatch: bool(item.countMismatch), ingestedAt: date(item.ingestedAt) };
  if (result.extractedCount !== result.entries.length || result.uniqueCount !== new Set(result.entries.map(entry => entry.candidateId)).size || result.duplicateCount !== result.extractedCount - result.uniqueCount || result.countMismatch !== (result.announcedCount !== result.extractedCount || result.announcedCount !== result.uniqueCount)) bad();
  return result;
}
function supplyTermsFixture(value: unknown, caseId: string, optional: string[] = []): Supply.SupplyTermsFixture {
  const item = record(value); keys(item, ['id', 'label', 'candidateId', 'rateCents', 'rateUnit', 'quantity', 'currency', 'totalCents', 'conditions', 'evidence'], optional);
  return { id: supplyId(item.id), label: string(item.label, 200), candidateId: supplyId(item.candidateId), rateCents: nullable(item.rateCents, value => number(value, 0, true)), rateUnit: nullable(item.rateUnit, value => choice(value, ['hour', 'event'])), quantity: nullable(item.quantity, value => number(value, Number.MIN_VALUE, false, 1_000_000)), currency: nullable(item.currency, value => choice(value, ['USD'])), totalCents: nullable(item.totalCents, value => number(value, 0, true)), conditions: nullable(item.conditions, value => string(value, 4000)), evidence: supplyEvidence(item.evidence, caseId) };
}
function checkedSupplyTerms(value: unknown, caseId: string): NonNullable<Supply.SupplyCandidate['terms']> {
  const item = record(value);
  const result = { ...supplyTermsFixture(item, caseId, ['checkedAt', 'checkedBy']), checkedAt: date(item.checkedAt), checkedBy: supplyId(item.checkedBy) };
  keys(item, Object.keys(result));
  return result;
}
function supplyCandidate(value: unknown, caseId: string): Supply.SupplyCandidate {
  const item = record(value); keys(item, ['id', 'caseId', 'revision', 'label', 'contact', 'source', 'sourceLink', 'readAt', 'city', 'coverage', 'announcedRateCents', 'announcedRateUnit', 'currency', 'announcements', 'evaluation', 'availability', 'terms', 'externalHired', 'evidence']);
  if (item.caseId !== caseId) bad();
  const evaluation = record(item.evaluation); keys(evaluation, ['verdict', 'checkedAt', 'checkedBy']);
  const availability = record(item.availability); keys(availability, ['status', 'window', 'checkedAt', 'checkedBy']);
  const result: Supply.SupplyCandidate = {
    id: supplyId(item.id), caseId, revision: revision(item.revision), label: string(item.label, 200), contact: syntheticContact(item.contact), source: choice(item.source, SUPPLY_SOURCES), sourceLink: syntheticSourceLink(item.sourceLink), readAt: date(item.readAt), city: nullable(item.city, value => string(value, 200)), coverage: nullable(item.coverage, value => strings(value, 20)), announcedRateCents: nullable(item.announcedRateCents, value => number(value, 0, true)), announcedRateUnit: nullable(item.announcedRateUnit, value => choice(value, ['hour', 'event'])), currency: nullable(item.currency, value => choice(value, ['USD'])),
    announcements: collection(item.announcements, supplyAnnouncement),
    evaluation: { verdict: nullable(evaluation.verdict, value => choice(value, ['eligible', 'rejected'])), checkedAt: nullableDate(evaluation.checkedAt), checkedBy: nullable(evaluation.checkedBy, supplyId) },
    availability: { status: choice(availability.status, ['unknown', 'available', 'unavailable']), window: nullable(availability.window, supplyWindow), checkedAt: nullableDate(availability.checkedAt), checkedBy: nullable(availability.checkedBy, supplyId) },
    terms: nullable(item.terms, value => checkedSupplyTerms(value, caseId)), externalHired: falseFact(item.externalHired), evidence: supplyEvidence(item.evidence, caseId),
  };
  if (!result.announcements.length || result.announcements.some(entry => entry.candidateId !== result.id) || (result.terms && result.terms.candidateId !== result.id)) bad();
  if ((result.evaluation.verdict === null) !== (result.evaluation.checkedAt === null) || (result.evaluation.checkedAt === null) !== (result.evaluation.checkedBy === null)) bad();
  if ((result.availability.status === 'unknown') !== (result.availability.window === null) || (result.availability.window === null) !== (result.availability.checkedAt === null) || (result.availability.checkedAt === null) !== (result.availability.checkedBy === null)) bad();
  return result;
}
function supplyQueue(value: unknown, caseId: string): Supply.SupplyQueue {
  const item = record(value); keys(item, ['id', 'caseId', 'status', 'reason', 'createdAt', 'updatedAt', 'externalResolved', 'evidence']);
  if (item.caseId !== caseId || item.reason !== 'sold_without_accepted_supplier') bad();
  const result: Supply.SupplyQueue = { id: supplyId(item.id), caseId, status: choice(item.status, ['queued', 'resolved_fixture']), reason: 'sold_without_accepted_supplier', createdAt: date(item.createdAt), updatedAt: date(item.updatedAt), externalResolved: falseFact(item.externalResolved), evidence: supplyEvidence(item.evidence, caseId) };
  if (Date.parse(result.updatedAt) < Date.parse(result.createdAt)) bad();
  return result;
}
function supplySelectionSnapshot(value: unknown, caseId: string): Supply.SupplySelectionSnapshot {
  const item = record(value); keys(item, ['candidate', 'event', 'terms']);
  const result = { candidate: supplyCandidate(item.candidate, caseId), event: supplyEvent(item.event, caseId), terms: checkedSupplyTerms(item.terms, caseId) };
  if (!result.candidate.terms || JSON.stringify(result.candidate.terms) !== JSON.stringify(result.terms)) bad();
  if (result.candidate.evaluation.verdict !== 'eligible' || result.candidate.availability.status !== 'available' || JSON.stringify(result.candidate.availability.window) !== JSON.stringify(result.event.window) || result.candidate.city !== result.event.city || !result.candidate.coverage?.includes(result.event.coverage)) bad();
  if (result.terms.rateCents === null || result.terms.rateUnit === null || result.terms.quantity === null || result.terms.currency === null || result.terms.totalCents === null || result.terms.conditions === null || result.terms.totalCents !== result.terms.rateCents * result.terms.quantity) bad();
  return result;
}
function supplySelection(value: unknown, caseId: string): Supply.SupplySelection {
  const item = record(value); keys(item, ['id', 'caseId', 'candidateId', 'revision', 'digest', 'snapshot', 'approvalId', 'reviewStatus', 'reviewedAt', 'assignedDemo', 'evidence']);
  if (item.caseId !== caseId) bad();
  const result = { id: supplyId(item.id), caseId, candidateId: supplyId(item.candidateId), revision: revision(item.revision), digest: digest(item.digest), snapshot: supplySelectionSnapshot(item.snapshot, caseId), approvalId: nullable(item.approvalId, supplyId), reviewStatus: choice(item.reviewStatus, SUPPLY_REVIEW_STATUSES), reviewedAt: nullableDate(item.reviewedAt), assignedDemo: bool(item.assignedDemo), evidence: supplyEvidence(item.evidence, caseId) };
  if (result.candidateId !== result.snapshot.candidate.id || (result.assignedDemo && (!['approved_demo', 'stale'].includes(result.reviewStatus) || !result.approvalId))) bad();
  return result;
}
function supplyAssignment(value: unknown, caseId: string): Supply.SupplyAssignment {
  const item = record(value); keys(item, ['id', 'caseId', 'candidateId', 'selectionId', 'selectionRevision', 'approvalId', 'window', 'assignedAt', 'status', 'externalHired', 'evidence'], ['revision', 'withdrawal']);
  if (item.caseId !== caseId) bad();
  const base = { id: supplyId(item.id), caseId, candidateId: supplyId(item.candidateId), selectionId: supplyId(item.selectionId), selectionRevision: revision(item.selectionRevision), approvalId: supplyId(item.approvalId), window: supplyWindow(item.window), assignedAt: date(item.assignedAt), externalHired: falseFact(item.externalHired), evidence: supplyEvidence(item.evidence, caseId) };
  if (item.status === 'assigned_demo') {
    if (item.revision !== undefined && item.revision !== 1 || Object.hasOwn(item, 'withdrawal')) bad();
    return { ...base, status: 'assigned_demo', revision: 1 };
  }
  if (item.status !== 'withdrawn_demo' || item.revision !== 2) bad();
  const withdrawal = record(item.withdrawal); keys(withdrawal, ['reason', 'at', 'by', 'evidence']);
  const reason = string(withdrawal.reason, 500), at = date(withdrawal.at), by = supplyId(withdrawal.by);
  if (!reason.trim() || reason !== reason.trim() || /[\u0000-\u001f\u007f]/.test(reason) || Date.parse(at) < Date.parse(base.assignedAt) || by !== 'OFFICE_DEMO_OPERATOR') bad();
  return { ...base, status: 'withdrawn_demo', revision: 2, withdrawal: { reason, at, by, evidence: supplyEvidence(withdrawal.evidence, caseId) } };
}
function supplyMenuFixture(value: unknown, caseId: string, optional: string[] = []): Supply.SupplyMenuFixture {
  const item = record(value); keys(item, ['id', 'label', 'menuRevision', 'items', 'recipes', 'evidence'], optional);
  return { id: supplyId(item.id), label: string(item.label, 200), menuRevision: revision(item.menuRevision), evidence: supplyEvidence(item.evidence, caseId),
    items: collection(item.items, value => { const row = record(value); keys(row, ['id', 'label', 'recipeId', 'servings']); return { id: supplyId(row.id), label: string(row.label, 200), recipeId: nullable(row.recipeId, supplyId), servings: nullable(row.servings, value => number(value, Number.MIN_VALUE, false, 1_000_000)) }; }),
    recipes: collection(item.recipes, value => { const row = record(value); keys(row, ['id', 'label', 'ingredients']); return { id: supplyId(row.id), label: string(row.label, 200), ingredients: collection(row.ingredients, value => { const ingredient = record(value); keys(ingredient, ['id', 'label', 'quantityPerServing', 'unit']); return { id: supplyId(ingredient.id), label: string(ingredient.label, 200), quantityPerServing: nullable(ingredient.quantityPerServing, value => number(value, Number.MIN_VALUE, false, 1_000_000)), unit: nullable(ingredient.unit, value => choice(value, ['g', 'unit'])) }; }) }; }) };
}
function supplyMenu(value: unknown, caseId: string): Supply.SupplyMenu {
  const item = record(value);
  const result = { ...supplyMenuFixture(item, caseId, ['revision', 'digest', 'validation', 'validatedAt', 'validatedBy', 'missingFacts']), revision: revision(item.revision), digest: digest(item.digest), validation: choice(item.validation, ['validated_demo', 'blocked']), validatedAt: nullableDate(item.validatedAt), validatedBy: nullable(item.validatedBy, supplyId), missingFacts: strings(item.missingFacts, 100) };
  keys(item, Object.keys(result));
  if (result.validation === 'validated_demo' && (!result.validatedAt || !result.validatedBy || result.missingFacts.length || !result.items.length || result.items.some(entry => !entry.recipeId || entry.servings === null || !result.recipes.some(recipe => recipe.id === entry.recipeId)) || result.recipes.some(recipe => !recipe.ingredients.length || recipe.ingredients.some(entry => entry.quantityPerServing === null || entry.unit === null)))) bad();
  return result;
}
function supplyPurchaseItem(value: unknown, optional: string[] = []): Supply.SupplyPurchaseItem {
  const item = record(value); keys(item, ['id', 'label', 'quantity', 'unit'], optional);
  return { id: supplyId(item.id), label: string(item.label, 200), quantity: nullable(item.quantity, value => number(value, Number.MIN_VALUE, false, 1_000_000_000)), unit: nullable(item.unit, value => choice(value, ['g', 'unit'])) };
}
function supplyPurchaseList(value: unknown, caseId: string): Supply.SupplyPurchaseList {
  const item = record(value); keys(item, ['id', 'caseId', 'revision', 'menuRevision', 'menuDigest', 'digest', 'items', 'createdAt', 'evidence']);
  if (item.caseId !== caseId) bad();
  return { id: supplyId(item.id), caseId, revision: revision(item.revision), menuRevision: revision(item.menuRevision), menuDigest: digest(item.menuDigest), digest: digest(item.digest), items: collection(item.items, value => supplyPurchaseItem(value)), createdAt: date(item.createdAt), evidence: supplyEvidence(item.evidence, caseId) };
}
function supplyPurchaseOptionFixture(value: unknown, caseId: string): Supply.SupplyPurchaseOptionFixture {
  const item = record(value); keys(item, ['id', 'label', 'service', 'deliveryAddress', 'deliveryWindow', 'prices', 'deliveryFeeCents', 'taxCents', 'currency', 'substitutions', 'evidence']);
  if (!Array.isArray(item.prices) || item.prices.length > 1000) bad();
  const prices = item.prices.map(value => { const row = record(value); keys(row, ['itemId', 'unitPriceCents']); return { itemId: supplyId(row.itemId), unitPriceCents: nullable(row.unitPriceCents, value => number(value, 0, true)) }; });
  if (new Set(prices.map(row => row.itemId)).size !== prices.length) bad();
  return { id: supplyId(item.id), label: string(item.label, 200), service: choice(item.service, ['instacart', 'similar']), deliveryAddress: nullable(item.deliveryAddress, value => string(value, 1000)), deliveryWindow: nullable(item.deliveryWindow, supplyWindow), prices, deliveryFeeCents: nullable(item.deliveryFeeCents, value => number(value, 0, true)), taxCents: nullable(item.taxCents, value => number(value, 0, true)), currency: nullable(item.currency, value => choice(value, ['USD'])), substitutions: nullable(item.substitutions, value => choice(value, ['no_substitutions_demo'])), evidence: supplyEvidence(item.evidence, caseId) };
}
function supplyPurchaseOptionFacts(value: unknown, caseId: string, optional: string[] = []): Supply.SupplyPurchaseSnapshot['option'] {
  const item = record(value); keys(item, ['id', 'caseId', 'fixtureId', 'revision', 'menuRevision', 'listRevision', 'label', 'service', 'deliveryAddress', 'deliveryWindow', 'items', 'itemsTotalCents', 'deliveryFeeCents', 'taxCents', 'totalCents', 'currency', 'substitutions', 'missingFacts', 'externalOrdered', 'externalPaid', 'externalReceived', 'evidence'], optional);
  if (item.caseId !== caseId) bad();
  return { id: supplyId(item.id), caseId, fixtureId: supplyId(item.fixtureId), revision: revision(item.revision), menuRevision: revision(item.menuRevision), listRevision: revision(item.listRevision), label: string(item.label, 200), service: choice(item.service, ['instacart', 'similar']), deliveryAddress: nullable(item.deliveryAddress, value => string(value, 1000)), deliveryWindow: nullable(item.deliveryWindow, supplyWindow),
    items: collection(item.items, value => { const row = record(value); const facts = supplyPurchaseItem(row, ['unitPriceCents', 'lineTotalCents']); keys(row, [...Object.keys(facts), 'unitPriceCents', 'lineTotalCents']); return { ...facts, unitPriceCents: nullable(row.unitPriceCents, value => number(value, 0, true)), lineTotalCents: nullable(row.lineTotalCents, value => number(value, 0, true)) }; }),
    itemsTotalCents: nullable(item.itemsTotalCents, value => number(value, 0, true)), deliveryFeeCents: nullable(item.deliveryFeeCents, value => number(value, 0, true)), taxCents: nullable(item.taxCents, value => number(value, 0, true)), totalCents: nullable(item.totalCents, value => number(value, 0, true)), currency: nullable(item.currency, value => choice(value, ['USD'])), substitutions: nullable(item.substitutions, value => choice(value, ['no_substitutions_demo'])), missingFacts: strings(item.missingFacts, 100), externalOrdered: falseFact(item.externalOrdered), externalPaid: falseFact(item.externalPaid), externalReceived: falseFact(item.externalReceived), evidence: supplyEvidence(item.evidence, caseId) };
}
function supplyPurchaseSnapshot(value: unknown, caseId: string): Supply.SupplyPurchaseSnapshot {
  const item = record(value); keys(item, ['menu', 'list', 'option']);
  const result = { menu: supplyMenu(item.menu, caseId), list: supplyPurchaseList(item.list, caseId), option: supplyPurchaseOptionFacts(item.option, caseId) };
  if (result.menu.validation !== 'validated_demo' || result.list.menuRevision !== result.menu.revision || result.list.menuDigest !== result.menu.digest || result.option.menuRevision !== result.menu.revision || result.option.listRevision !== result.list.revision) bad();
  const option = result.option;
  if (option.missingFacts.length || !option.deliveryAddress || !option.deliveryWindow || option.currency === null || option.substitutions === null || option.itemsTotalCents === null || option.deliveryFeeCents === null || option.taxCents === null || option.totalCents === null || !result.list.items.length || option.items.length !== result.list.items.length) bad();
  for (const item of option.items) {
    const listed = result.list.items.find(entry => entry.id === item.id);
    if (!listed || item.quantity === null || item.unit === null || item.quantity !== listed.quantity || item.unit !== listed.unit || item.unitPriceCents === null || item.lineTotalCents !== item.quantity * item.unitPriceCents) bad();
  }
  if (option.itemsTotalCents !== option.items.reduce((sum, item) => sum + item.lineTotalCents!, 0) || option.totalCents !== option.itemsTotalCents + option.deliveryFeeCents + option.taxCents) bad();
  return result;
}
function supplyPurchaseOption(value: unknown, caseId: string): Supply.SupplyPurchaseOption {
  const item = record(value);
  const facts = supplyPurchaseOptionFacts(item, caseId, ['approvalId', 'reviewStatus', 'reviewedAt', 'snapshot', 'digest']);
  const result = { ...facts, approvalId: nullable(item.approvalId, supplyId), reviewStatus: choice(item.reviewStatus, SUPPLY_REVIEW_STATUSES), reviewedAt: nullableDate(item.reviewedAt), snapshot: nullable(item.snapshot, value => supplyPurchaseSnapshot(value, caseId)), digest: digest(item.digest) };
  keys(item, Object.keys(result));
  if (result.snapshot && JSON.stringify(result.snapshot.option) !== JSON.stringify(facts)) bad();
  return result;
}
function supplyReviewContext(value: unknown, mode: DataMode, caseId: string): Supply.SupplyReviewContext {
  const item = record(value);
  if (mode !== 'demo' || item.schemaVersion !== 1 || item.caseId !== caseId) bad();
  if (item.kind === 'selection') {
    keys(item, ['schemaVersion', 'kind', 'caseId', 'selectionId', 'revision', 'digest', 'snapshot', 'evidence']);
    return { schemaVersion: 1, kind: 'selection', caseId, selectionId: supplyId(item.selectionId), revision: revision(item.revision), digest: digest(item.digest), snapshot: supplySelectionSnapshot(item.snapshot, caseId), evidence: supplyEvidence(item.evidence, caseId) };
  }
  if (item.kind === 'purchase') {
    keys(item, ['schemaVersion', 'kind', 'caseId', 'optionId', 'revision', 'digest', 'snapshot', 'evidence']);
    const snapshot = supplyPurchaseSnapshot(item.snapshot, caseId);
    const optionId = supplyId(item.optionId); const reviewRevision = revision(item.revision);
    if (snapshot.option.id !== optionId || snapshot.option.revision !== reviewRevision) bad();
    return { schemaVersion: 1, kind: 'purchase', caseId, optionId, revision: reviewRevision, digest: digest(item.digest), snapshot, evidence: supplyEvidence(item.evidence, caseId) };
  }
  bad();
}
function supplyWorkflow(value: unknown, mode: DataMode, caseId: string): Supply.SupplyWorkflow {
  const item = record(value); keys(item, ['mode', 'event'], ['sourcing', 'procurement']);
  if (mode !== 'demo' || item.mode !== 'demo') bad();
  const result: Supply.SupplyWorkflow = { mode: 'demo', event: supplyEvent(item.event, caseId) };
  if (Object.hasOwn(item, 'sourcing')) {
    const sourcing = record(item.sourcing); keys(sourcing, ['queue', 'digests', 'candidates', 'selections', 'assignments', 'digestFixtures', 'termsFixtures']);
    result.sourcing = { queue: nullable(sourcing.queue, value => supplyQueue(value, caseId)), digests: collection(sourcing.digests, value => supplyDigestRecord(value, caseId)), candidates: collection(sourcing.candidates, value => supplyCandidate(value, caseId)), selections: collection(sourcing.selections, value => supplySelection(value, caseId)), assignments: collection(sourcing.assignments, value => supplyAssignment(value, caseId)), digestFixtures: collection(sourcing.digestFixtures, value => supplyDigestFixture(value, caseId)), termsFixtures: collection(sourcing.termsFixtures, value => supplyTermsFixture(value, caseId)) };
    if (result.sourcing.assignments.filter(row => row.status === 'assigned_demo').length > 1) bad();
  }
  if (Object.hasOwn(item, 'procurement')) {
    const procurement = record(item.procurement); keys(procurement, ['menu', 'list', 'options', 'selectedOptionId', 'menuFixtures', 'optionFixtures']);
    const scoped = { menu: nullable(procurement.menu, value => supplyMenu(value, caseId)), list: nullable(procurement.list, value => supplyPurchaseList(value, caseId)), options: collection(procurement.options, value => supplyPurchaseOption(value, caseId)), selectedOptionId: nullable(procurement.selectedOptionId, supplyId), menuFixtures: collection(procurement.menuFixtures, value => supplyMenuFixture(value, caseId)), optionFixtures: collection(procurement.optionFixtures, value => supplyPurchaseOptionFixture(value, caseId)) };
    if (scoped.selectedOptionId && !scoped.options.some(option => option.id === scoped.selectedOptionId)) bad();
    result.procurement = scoped;
  }
  return result;
}
function officeCase(value: unknown, mode: DataMode): OfficeCase {
  const c = record(value);
  keys(c, ['id', 'title', 'subtitle', 'evidence', 'payment', 'paymentEvidence', 'supplier', 'supplierEvidence', 'capturedAt', 'attemptedAt', 'connectedAt', 'humanContactVerified', 'callEvidence', 'closerAvailable', 'assignment', 'saleClosed', 'history', 'tasks', 'results', 'approvals', 'messages'], ['commercialThreads', 'supplyWorkflow']);
  const caseId = id(c.id);
  const result: OfficeCase = {
    id: caseId, title: string(c.title, 200), subtitle: string(c.subtitle, 600), evidence: evidence(c.evidence, mode, caseId),
    payment: choice(c.payment, ['verified', 'pending', 'unknown']), paymentEvidence: nullableEvidence(c.paymentEvidence, mode, caseId),
    supplier: choice(c.supplier, ['accepted', 'pending', 'unknown']), supplierEvidence: nullableEvidence(c.supplierEvidence, mode, caseId),
    capturedAt: date(c.capturedAt), attemptedAt: nullableDate(c.attemptedAt), connectedAt: nullableDate(c.connectedAt),
    humanContactVerified: bool(c.humanContactVerified), callEvidence: nullableEvidence(c.callEvidence, mode, caseId),
    closerAvailable: nullableBool(c.closerAvailable), assignment: choice(c.assignment, ['assigned', 'queued', 'unknown']), saleClosed: nullableBool(c.saleClosed),
    tasks: collection(c.tasks, value => { const item = record(value); keys(item, ['id', 'area', 'functionId', 'title', 'detail', 'status', 'evidence']); return { ...base(item, mode, caseId), area: choice(item.area, AREAS), title: string(item.title, 200), detail: string(item.detail), status: choice(item.status, STATUSES) }; }),
    results: collection(c.results, value => { const item = record(value); keys(item, ['id', 'area', 'functionId', 'title', 'detail', 'evidence']); return { ...base(item, mode, caseId), area: choice(item.area, AREAS), title: string(item.title, 200), detail: string(item.detail) }; }),
    approvals: collection(c.approvals, value => {
      const item = record(value); keys(item, ['id', 'area', 'functionId', 'title', 'body', 'recipient', 'account', 'attachments', 'channel', 'revision', 'digest', 'status', 'evidence'], ['commercialContext', 'supplyContext']);
      if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || !DIGEST.test(string(item.digest, 64))) bad();
      if (!Array.isArray(item.attachments) || item.attachments.length > 20) bad();
      const context = Object.hasOwn(item, 'commercialContext') ? commercialThread(item.commercialContext, mode, caseId) : undefined;
      if (context && (item.functionId !== 'sales' || item.recipient !== context.recipient)) bad();
      const supplyContext = Object.hasOwn(item, 'supplyContext') ? supplyReviewContext(item.supplyContext, mode, caseId) : undefined;
      if (supplyContext && (context || item.functionId !== (supplyContext.kind === 'selection' ? 'suppliers' : 'logistics') || item.recipient !== 'supply-review@invalid.test' || item.channel !== 'email' || item.attachments.length !== 0)) bad();
      return { ...base(item, mode, caseId), area: choice(item.area, AREAS), title: string(item.title, 200), body: string(item.body, 12000), recipient: string(item.recipient, 300), account: string(item.account, 300), attachments: item.attachments.map(value => string(value, 1000)), channel: string(item.channel, 100), revision: item.revision as number, digest: item.digest as string, status: choice(item.status, ['pending', 'approved_demo', 'rejected_demo', 'cancelled_demo']), ...(context ? { commercialContext: context } : {}), ...(supplyContext ? { supplyContext } : {}) };
    }),
    messages: collection(c.messages, value => { const item = record(value); keys(item, ['id', 'area', 'functionId', 'author', 'text', 'evidence']); return { ...base(item, mode, caseId), area: choice(item.area, AREAS), author: string(item.author, 100), text: string(item.text, 12000) }; }),
    history: collection(c.history, value => { const item = record(value); keys(item, ['id', 'functionId', 'title', 'detail', 'status', 'evidence']); return { ...base(item, mode, caseId), title: string(item.title, 200), detail: string(item.detail), status: choice(item.status, STATUSES) }; }),
  };
  if (Object.hasOwn(c, 'commercialThreads')) {
    if (mode !== 'demo' || !Array.isArray(c.commercialThreads) || c.commercialThreads.length > 20) bad();
    result.commercialThreads = collection(c.commercialThreads, value => commercialThread(value, mode, caseId));
  }
  if (Object.hasOwn(c, 'supplyWorkflow')) result.supplyWorkflow = supplyWorkflow(c.supplyWorkflow, mode, caseId);
  if ((result.payment === 'verified' && !result.paymentEvidence) || (result.supplier === 'accepted' && !result.supplierEvidence)) bad();
  if ((result.attemptedAt || result.connectedAt || result.humanContactVerified) && !result.callEvidence) bad();
  if (result.connectedAt && !result.humanContactVerified) bad();
  if (result.humanContactVerified && !result.connectedAt) bad();
  if (result.attemptedAt && Date.parse(result.attemptedAt) < Date.parse(result.capturedAt)) bad();
  if (result.connectedAt && (Date.parse(result.connectedAt) < Date.parse(result.capturedAt) || (result.attemptedAt && Date.parse(result.connectedAt) < Date.parse(result.attemptedAt)))) bad();
  if (mode !== 'demo' && result.approvals.some(approval => approval.status !== 'pending')) bad();
  return result;
}

export function validateOfficeSnapshot(value: unknown, expectedMode: 'demo' | 'live'): OfficeSnapshot {
  const item = record(value); keys(item, ['mode', 'asOf', 'cases', 'note', 'outboundEffects', 'mondayWrites'], ['hasMore']);
  if (item.mode !== expectedMode || item.outboundEffects !== 0 || item.mondayWrites !== 0) bad();
  const result: OfficeSnapshot = { mode: expectedMode, asOf: date(item.asOf), cases: collection(item.cases, value => officeCase(value, expectedMode)), note: string(item.note, 3000), outboundEffects: 0, mondayWrites: 0 };
  if (Object.hasOwn(item, 'hasMore')) result.hasMore = bool(item.hasMore);
  return result;
}

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Solicitud cancelada.', 'AbortError'); }
async function requestJson(url: string, signal?: AbortSignal, command?: unknown, method?: 'POST' | 'DELETE'): Promise<unknown> {
  aborted(signal);
  let response: Response;
  try {
    response = await fetch(url, { method: method ?? (command ? 'POST' : 'GET'), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(command ? { 'Content-Type': 'application/json' } : {}) }, ...(command ? { body: JSON.stringify(command) } : {}) });
  } catch { aborted(signal); throw new OfficeReadError('offline'); }
  aborted(signal);
  if (!response.ok) {
    if (response.status === 401) throw new OfficeReadError('unauthorized');
    if (response.status === 403) throw new OfficeReadError('forbidden');
    if (response.status === 409) throw new OfficeReadError('conflict');
    if ([400, 422].includes(response.status)) throw new OfficeReadError('validation');
    throw new OfficeReadError('offline');
  }
  if (method === 'DELETE' && response.status === 204) return null;
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') bad();
  try { const value: unknown = await response.json(); aborted(signal); return value; }
  catch (error) { aborted(signal); if (error instanceof OfficeReadError) throw error; bad(); }
}

export type DemoSession = {
  mode: 'demo'; actorId: string; role: 'operator' | 'viewer'; caseIds: string[];
  functionIds: FunctionId[]; expiresAt: string; storage: { kind: 'postgres'; durable: true }; outboundEffects: 0;
};
export type DemoSessionScope = { role?: 'operator' | 'viewer'; caseIds?: string[]; functionIds?: FunctionId[] };

function validateDemoSession(value: unknown): DemoSession {
  const item = record(value);
  keys(item, ['mode', 'actorId', 'role', 'caseIds', 'functionIds', 'expiresAt', 'storage', 'outboundEffects']);
  const storage = record(item.storage); keys(storage, ['kind', 'durable']);
  if (item.mode !== 'demo' || item.actorId !== 'OFFICE_DEMO_OPERATOR' || item.outboundEffects !== 0 || storage.kind !== 'postgres' || storage.durable !== true) bad();
  const scoped = <T extends string>(value: unknown, allowed: readonly T[]): T[] => {
    if (!Array.isArray(value) || value.length === 0 || value.length > allowed.length || new Set(value).size !== value.length) bad();
    return value.map(entry => choice(entry, allowed));
  };
  const expiresAt = date(item.expiresAt);
  if (Date.parse(expiresAt) <= Date.now()) throw new OfficeReadError('unauthorized');
  return { mode: 'demo', actorId: item.actorId, role: choice(item.role, ['operator', 'viewer']),
    caseIds: scoped(item.caseIds, ['demo-aurora', 'demo-cedar', 'demo-harbor']),
    functionIds: scoped(item.functionIds, FUNCTIONS), expiresAt, storage: { kind: 'postgres', durable: true }, outboundEffects: 0 };
}

export async function loadDemoSession(signal?: AbortSignal): Promise<DemoSession | null> {
  try { return validateDemoSession(await requestJson('/office-api/session', signal)); }
  catch (error) { if (error instanceof OfficeReadError && error.code === 'unauthorized') return null; throw error; }
}

export async function startDemoSession(scope: DemoSessionScope = {}, signal?: AbortSignal): Promise<DemoSession> {
  try {
    const item = record(scope); keys(item, [], ['role', 'caseIds', 'functionIds']);
    if (item.role !== undefined) choice(item.role, ['operator', 'viewer']);
    for (const [key, allowed] of [['caseIds', ['demo-aurora', 'demo-cedar', 'demo-harbor']], ['functionIds', FUNCTIONS]] as const) {
      if (item[key] === undefined) continue;
      const values = item[key];
      if (!Array.isArray(values) || values.length === 0 || values.length > allowed.length || new Set(values).size !== values.length) bad();
      values.forEach(value => choice(value, allowed));
    }
  } catch { throw new OfficeReadError('validation'); }
  return validateDemoSession(await requestJson('/office-api/session', signal, scope, 'POST'));
}

export async function endDemoSession(signal?: AbortSignal): Promise<void> {
  await requestJson('/office-api/session', signal, undefined, 'DELETE');
}

export async function loadDemoSnapshot(signal?: AbortSignal): Promise<OfficeSnapshot> {
  return validateOfficeSnapshot(await requestJson('/office-api/snapshot', signal), 'demo');
}

function validatedCommand(command: OfficeCommand): OfficeCommand {
  try {
    const item = record(command);
    choice(item.action, ['draft', 'chat', 'approve', 'reject', 'cancel', 'revise']);
    const decision = ['approve', 'reject', 'cancel', 'revise'].includes(command.action);
    const required = ['idempotencyKey', 'caseId', 'functionId', 'action', ...(decision ? ['approvalId', 'revision', 'digest'] : []), ...(['chat', 'revise'].includes(command.action) ? ['text'] : [])];
    const commercialFields = ['commercialThreadId', 'commercialThreadRevision', 'commercialThreadDigest'];
    keys(item, required, command.action === 'draft' ? ['text', ...commercialFields, 'supply'] : []);
    const commandId = (value: unknown) => { const result = id(value); if (result.length > 96 || ['__proto__', 'prototype', 'constructor'].includes(result)) bad(); return result; };
    commandId(item.idempotencyKey); choice(item.caseId, ['demo-aurora', 'demo-cedar', 'demo-harbor']); choice(item.functionId, FUNCTIONS);
    if (item.text !== undefined) string(item.text, 2000);
    if (item.approvalId !== undefined) commandId(item.approvalId);
    if (item.revision !== undefined && (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1 || (item.revision as number) > 1_000_000)) bad();
    if (item.digest !== undefined && !DIGEST.test(string(item.digest, 64))) bad();
    if (commercialFields.some(key => Object.hasOwn(item, key))) {
      if (!commercialFields.every(key => Object.hasOwn(item, key)) || item.action !== 'draft' || item.functionId !== 'sales' || Object.hasOwn(item, 'text') || Object.hasOwn(item, 'supply')) bad();
      commandId(item.commercialThreadId);
      if (!Number.isSafeInteger(item.commercialThreadRevision) || (item.commercialThreadRevision as number) < 1 || (item.commercialThreadRevision as number) > 1_000_000) bad();
      if (!DIGEST.test(string(item.commercialThreadDigest, 64))) bad();
    }
    if (Object.hasOwn(item, 'supply')) {
      if (item.action !== 'draft' || !isSupplyOperation(item.supply) || Object.hasOwn(item, 'text') || commercialFields.some(key => Object.hasOwn(item, key))) bad();
      const procurement = ['validate_menu', 'build_purchase_list', 'choose_purchase_option', 'review_purchase'].includes(item.supply.step);
      if (item.functionId !== (procurement ? 'logistics' : 'suppliers')) bad();
    }
    if (['chat', 'revise'].includes(command.action) && item.text === undefined) bad();
    if (['approve', 'reject', 'cancel', 'revise'].includes(command.action) && (item.approvalId === undefined || item.revision === undefined || item.digest === undefined)) bad();
    return { ...command };
  } catch { throw new OfficeReadError('validation'); }
}

export async function executeDemoCommand(command: OfficeCommand, signal?: AbortSignal): Promise<{ snapshot: OfficeSnapshot; replayed: boolean }> {
  const input = validatedCommand(command);
  const item = record(await requestJson('/office-api/command', signal, input)); keys(item, ['snapshot', 'replayed']);
  const snapshot = validateOfficeSnapshot(item.snapshot, 'demo');
  if (!snapshot.cases.some(c => c.id === input.caseId)) bad();
  return { snapshot, replayed: bool(item.replayed) };
}

// Dormant until the existing staff auth is integrated in M2. GETs only; this
// adapter never invokes public lead creation, Monday, telephony or a provider.
export async function loadLiveSnapshot(signal?: AbortSignal): Promise<OfficeSnapshot> {
  const auth = record(await requestJson('/v1/admin/auth/me', signal)); keys(auth, ['user', 'expires_at']);
  const user = record(auth.user); keys(user, ['staff_user_id', 'email', 'role']);
  if (!UUID.test(string(user.staff_user_id, 36))) bad();
  string(user.email, 254); choice(user.role, ['admin', 'viewer']);
  if (Date.parse(date(auth.expires_at)) <= Date.now()) throw new OfficeReadError('unauthorized');
  const payload = record(await requestJson('/v1/admin/leads?range=7d&include_qa=false&limit=50', signal)); keys(payload, ['range', 'rows', 'next_cursor']);
  const range = record(payload.range); keys(range, ['from', 'to', 'label', 'timezone', 'include_qa']);
  const from = date(range.from); const to = date(range.to); string(range.label, 100);
  if (Date.parse(from) >= Date.parse(to) || range.timezone !== 'America/Los_Angeles' || range.include_qa !== false) bad();
  if (payload.next_cursor !== null) string(payload.next_cursor, 500);
  if (!Array.isArray(payload.rows) || payload.rows.length > 50) bad();
  const allowed = ['lead_id', 'session_id', 'status', 'created_at', 'updated_at', 'is_qa', 'intent_cluster', 'crm_status', 'monday_item_url', 'monday_synced_at', 'crm_last_error_code', 'event_type', 'guest_range', 'service_style', 'zip_code', 'source', 'campaign', 'completed', 'time_to_lead_ms', 'phone_captured'];
  const ids = new Set<string>();
  const observedAt = new Date().toISOString();
  const cases: OfficeCase[] = [];
  for (const value of payload.rows) {
    const row = record(value); keys(row, ['lead_id', 'status', 'created_at', 'updated_at', 'is_qa', 'completed', 'phone_captured'], allowed);
    const leadId = string(row.lead_id, 36); if (!UUID.test(leadId) || ids.has(leadId)) bad(); ids.add(leadId);
    choice(row.status, ['captured', 'completed']); const createdAt = date(row.created_at); const updatedAt = date(row.updated_at);
    if (Date.parse(updatedAt) < Date.parse(createdAt)) bad(); bool(row.completed); bool(row.phone_captured);
    for (const key of ['session_id']) if (row[key] !== undefined && !UUID.test(string(row[key], 36))) bad();
    for (const key of ['intent_cluster', 'crm_status', 'monday_item_url', 'crm_last_error_code', 'event_type', 'guest_range', 'service_style', 'zip_code', 'source', 'campaign']) if (row[key] !== undefined && row[key] !== null) string(row[key], 2000, true);
    if (row.monday_synced_at !== undefined && row.monday_synced_at !== null) date(row.monday_synced_at);
    if (row.time_to_lead_ms !== undefined && (typeof row.time_to_lead_ms !== 'number' || !Number.isFinite(row.time_to_lead_ms) || row.time_to_lead_ms < 0)) bad();
    if (bool(row.is_qa)) continue;
    const fact: Evidence = { source: 'growth_v2.leads.created_at (registro PostgreSQL)', at: createdAt, simulated: false, reference: `growth_v2:lead:${leadId}:registered` };
    const unavailable: Evidence = { source: 'office:read-projection', at: observedAt, simulated: false, reference: `growth_v2:lead:${leadId}:missing-operational-evidence` };
    cases.push({
      id: leadId, title: `Lead ${leadId.slice(0, 8)}`, subtitle: 'Registro PostgreSQL; fecha de captura del proveedor aún no verificada.', evidence: fact,
      capturedAt: createdAt, attemptedAt: null, connectedAt: null, humanContactVerified: false, callEvidence: null,
      payment: 'unknown', paymentEvidence: null, supplier: 'unknown', supplierEvidence: null, closerAvailable: null, assignment: 'unknown', saleClosed: null,
      tasks: [{ id: `${leadId}:availability`, area: 'sales', functionId: 'sales', title: 'Verificar asignación y llamada', detail: 'El registro del formulario no acredita un closer activo, una asignación o una llamada real.', status: 'blocked', evidence: unavailable }],
      history: [{ id: `${leadId}:registered`, functionId: 'sales', title: 'Lead registrado', detail: 'Primer registro conservado en growth_v2. Completar el formulario no acredita cierre de venta ni ejecución del evento.', status: 'completed', evidence: fact }],
      results: [{ id: `${leadId}:capture`, area: 'sales', functionId: 'sales', title: 'Registro de lead recibido', detail: 'Lectura del registro existente; datos operativos no conectados.', evidence: fact }], approvals: [], messages: [],
    });
  }
  return { mode: 'live', asOf: observedAt, cases, note: 'Solo lectura de growth_v2; sin evidencia operativa de asignación, llamadas, venta, pagos o proveedor. created_at acredita registro PostgreSQL, no captura fiable del proveedor. No se incluyen datos QA ni teléfonos.', hasMore: payload.next_cursor !== null, outboundEffects: 0, mondayWrites: 0 };
}
