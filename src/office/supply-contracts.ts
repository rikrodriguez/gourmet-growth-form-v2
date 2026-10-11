import type { Evidence, WorkStatus } from './contracts';

export type SupplyOperation =
  | { step: 'queue_sourcing' }
  | { step: 'ingest_digest'; fixtureId: string }
  | { step: 'evaluate_candidate'; candidateId: string; revision: number; verdict: 'eligible' | 'rejected' }
  | { step: 'verify_availability'; candidateId: string; revision: number; status: 'available' | 'unavailable' }
  | { step: 'approve_terms'; candidateId: string; revision: number; termsFixtureId: string }
  | { step: 'select_candidate'; candidateId: string; revision: number }
  | { step: 'assign_demo'; selectionId: string; revision: number }
  | { step: 'validate_menu'; fixtureId: string }
  | { step: 'build_purchase_list' }
  | { step: 'choose_purchase_option'; optionFixtureId: string; listRevision: number }
  | { step: 'review_purchase'; optionId: string; revision: number };

const FIELDS: Record<SupplyOperation['step'], readonly string[]> = {
  queue_sourcing: [], ingest_digest: ['fixtureId'],
  evaluate_candidate: ['candidateId', 'revision', 'verdict'],
  verify_availability: ['candidateId', 'revision', 'status'],
  approve_terms: ['candidateId', 'revision', 'termsFixtureId'],
  select_candidate: ['candidateId', 'revision'], assign_demo: ['selectionId', 'revision'],
  validate_menu: ['fixtureId'], build_purchase_list: [],
  choose_purchase_option: ['optionFixtureId', 'listRevision'], review_purchase: ['optionId', 'revision'],
};

// Browser-safe guard shared with the server parser. Inspect descriptors before
// reading any value; operations contain only primitive server-owned IDs/choices.
export function isSupplyOperation(raw: unknown): raw is SupplyOperation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return false;
  const keys = Reflect.ownKeys(raw);
  const values: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return false;
    values[key] = descriptor.value;
  }
  if (typeof values.step !== 'string' || !Object.hasOwn(FIELDS, values.step)) return false;
  const allowed = ['step', ...FIELDS[values.step as SupplyOperation['step']]];
  if (keys.length !== allowed.length || allowed.some(key => !Object.hasOwn(values, key))) return false;
  const id = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value) && !['__proto__', 'prototype', 'constructor'].includes(value);
  for (const key of allowed.filter(key => key.endsWith('Id'))) if (!id(values[key])) return false;
  for (const key of ['revision', 'listRevision']) if (Object.hasOwn(values, key) && (!Number.isSafeInteger(values[key]) || (values[key] as number) < 1 || (values[key] as number) > 1_000_000)) return false;
  if (values.step === 'evaluate_candidate' && !['eligible', 'rejected'].includes(values.verdict as string)) return false;
  if (values.step === 'verify_availability' && !['available', 'unavailable'].includes(values.status as string)) return false;
  return true;
}

export type SupplySource = 'facebook_marketplace' | 'facebook_groups' | 'outreach_forms' | 'meetachef';
export type SupplyWindow = { startAt: string; endAt: string };
export type SyntheticSupplyEvent = { id: string; caseId: string; revision: 1; city: string; coverage: string; window: SupplyWindow; evidence: Evidence };
export type SupplyCandidateAnnouncement = {
  id: string; candidateId: string; label: string; contact: string; source: SupplySource;
  sourceLink: string; readAt: string; city: string | null; coverage: string[] | null;
  announcedRateCents: number | null; announcedRateUnit: 'hour' | 'event' | null; currency: 'USD' | null;
};
export type SupplyDigestFixture = { id: string; label: string; announcedCount: number; entries: SupplyCandidateAnnouncement[]; evidence: Evidence };
export type SupplyDigestRecord = SupplyDigestFixture & { extractedCount: number; uniqueCount: number; duplicateCount: number; countMismatch: boolean; ingestedAt: string };
export type SupplyTermsFixture = { id: string; label: string; candidateId: string; rateCents: number | null; rateUnit: 'hour' | 'event' | null; quantity: number | null; currency: 'USD' | null; totalCents: number | null; conditions: string | null; evidence: Evidence };
export type SupplyCandidate = {
  id: string; caseId: string; revision: number; label: string; contact: string;
  source: SupplySource; sourceLink: string; readAt: string; city: string | null; coverage: string[] | null;
  announcedRateCents: number | null; announcedRateUnit: 'hour' | 'event' | null; currency: 'USD' | null;
  announcements: SupplyCandidateAnnouncement[];
  evaluation: { verdict: 'eligible' | 'rejected' | null; checkedAt: string | null; checkedBy: string | null };
  availability: { status: 'unknown' | 'available' | 'unavailable'; window: SupplyWindow | null; checkedAt: string | null; checkedBy: string | null };
  terms: (SupplyTermsFixture & { checkedAt: string; checkedBy: string }) | null;
  externalHired: false; evidence: Evidence;
};
export type SupplyQueue = { id: string; caseId: string; status: 'queued' | 'resolved_fixture'; reason: 'sold_without_accepted_supplier'; createdAt: string; updatedAt: string; externalResolved: false; evidence: Evidence };
export type SupplySelectionSnapshot = { candidate: SupplyCandidate; event: SyntheticSupplyEvent; terms: NonNullable<SupplyCandidate['terms']> };
export type SupplyReviewStatus = 'pending' | 'approved_demo' | 'rejected_demo' | 'cancelled_demo' | 'stale';
export type SupplySelection = {
  id: string; caseId: string; candidateId: string; revision: number; digest: string; snapshot: SupplySelectionSnapshot;
  approvalId: string | null; reviewStatus: SupplyReviewStatus; reviewedAt: string | null; assignedDemo: boolean; evidence: Evidence;
};
export type SupplyAssignment = { id: string; caseId: string; candidateId: string; selectionId: string; selectionRevision: number; approvalId: string; window: SupplyWindow; assignedAt: string; status: 'assigned_demo'; externalHired: false; evidence: Evidence };

export type SupplyMenuItem = { id: string; label: string; recipeId: string | null; servings: number | null };
export type SupplyRecipe = { id: string; label: string; ingredients: Array<{ id: string; label: string; quantityPerServing: number | null; unit: 'g' | 'unit' | null }> };
export type SupplyMenuFixture = { id: string; label: string; menuRevision: number; items: SupplyMenuItem[]; recipes: SupplyRecipe[]; evidence: Evidence };
export type SupplyMenu = SupplyMenuFixture & { revision: number; digest: string; validation: 'validated_demo' | 'blocked'; validatedAt: string | null; validatedBy: string | null; missingFacts: string[] };
export type SupplyPurchaseItem = { id: string; label: string; quantity: number | null; unit: 'g' | 'unit' | null };
export type SupplyPurchaseList = { id: string; caseId: string; revision: number; menuRevision: number; menuDigest: string; digest: string; items: SupplyPurchaseItem[]; createdAt: string; evidence: Evidence };
export type SupplyPurchaseOptionFixture = {
  id: string; label: string; service: 'instacart' | 'similar'; deliveryAddress: string | null; deliveryWindow: SupplyWindow | null;
  prices: Array<{ itemId: string; unitPriceCents: number | null }>; deliveryFeeCents: number | null; taxCents: number | null; currency: 'USD' | null;
  substitutions: 'no_substitutions_demo' | null; evidence: Evidence;
};
export type SupplyPurchaseSnapshot = { menu: SupplyMenu; list: SupplyPurchaseList; option: Omit<SupplyPurchaseOption, 'approvalId' | 'reviewStatus' | 'reviewedAt' | 'snapshot' | 'digest'> };
export type SupplyPurchaseOption = {
  id: string; caseId: string; fixtureId: string; revision: number; menuRevision: number; listRevision: number;
  label: string; service: 'instacart' | 'similar'; deliveryAddress: string | null; deliveryWindow: SupplyWindow | null;
  items: Array<SupplyPurchaseItem & { unitPriceCents: number | null; lineTotalCents: number | null }>;
  itemsTotalCents: number | null; deliveryFeeCents: number | null; taxCents: number | null; totalCents: number | null; currency: 'USD' | null;
  substitutions: 'no_substitutions_demo' | null; missingFacts: string[];
  externalOrdered: false; externalPaid: false; externalReceived: false;
  approvalId: string | null; reviewStatus: SupplyReviewStatus; reviewedAt: string | null;
  snapshot: SupplyPurchaseSnapshot | null; digest: string; evidence: Evidence;
};
export type SupplyReviewContext =
  | { schemaVersion: 1; kind: 'selection'; caseId: string; selectionId: string; revision: number; digest: string; snapshot: SupplySelectionSnapshot; evidence: Evidence }
  | { schemaVersion: 1; kind: 'purchase'; caseId: string; optionId: string; revision: number; digest: string; snapshot: SupplyPurchaseSnapshot; evidence: Evidence };
export type SupplyCaseState = { event: SyntheticSupplyEvent; queue: SupplyQueue | null; digests: Record<string, SupplyDigestRecord>; candidates: Record<string, SupplyCandidate>; selections: Record<string, SupplySelection>; menu: SupplyMenu | null; list: SupplyPurchaseList | null; selectedOptionId: string | null; options: Record<string, SupplyPurchaseOption> };
export type SupplyState = { schemaVersion: 1; cases: Record<string, SupplyCaseState>; assignments: Record<string, SupplyAssignment> };
export type SupplyWorkflow = {
  mode: 'demo'; event: SyntheticSupplyEvent;
  sourcing?: { queue: SupplyQueue | null; digests: SupplyDigestRecord[]; candidates: SupplyCandidate[]; selections: SupplySelection[]; assignments: SupplyAssignment[]; digestFixtures: SupplyDigestFixture[]; termsFixtures: SupplyTermsFixture[] };
  procurement?: { menu: SupplyMenu | null; list: SupplyPurchaseList | null; selectedOptionId: string | null; options: SupplyPurchaseOption[]; menuFixtures: SupplyMenuFixture[]; optionFixtures: SupplyPurchaseOptionFixture[] };
};
export type SupplyOperationResult = { title: string; detail: string; status: WorkStatus; review?: { title: string; body: string; context: SupplyReviewContext } };
