import { createRequire } from 'node:module';
import type { OfficeState, OfficeStore, DemoCaseId, ApprovalLink } from './state';
import { CASE_IDS, DEMO_ACTOR, sha256 } from './state';

// Typed boundary around the existing ESM pilot; no copy of the domain logic.
const require = createRequire(import.meta.url);
type Review = { reviewDigest: string; text: string; blockedReason: string | null };
type DraftModule = {
  createQuoteDraft: (state: OfficeState, input: object, options: { nowMs: number }) => { draftId: string; revision: number };
  prepareMessageDraft: (state: OfficeState, input: object, options: { nowMs: number }) => { draftId: string; revision: number };
  reviewMessageDraft: (state: OfficeState, input: { draftId: string; revision: number }) => Review;
};
export const draftCore = require('../../operations/drafts.mjs') as DraftModule;
const pilotCore = require('../../operations/pilot-adapter.mjs') as { createPilotAdapter: (options: { store: OfficeStore; mode: 'simulation'; policy: object; clock: () => number }) => { execute(envelope: object, context: object): Promise<{ data: unknown; replayed: boolean }> } };
const paymentCore = require('../../operations/payments.mjs') as {
  registerInvoice(state: OfficeState, input: object): unknown;
  applyConfirmedPayment(state: OfficeState, input: object, options: { nowMs: number }): unknown;
};
export { paymentCore };
export function computeApprovalDigest(state: OfficeState, link: ApprovalLink) {
  const reviewed = draftCore.reviewMessageDraft(state, { draftId: link.coreDraftId, revision: link.revision });
  return sha256({ account: link.account, channel: link.channel, recipient: link.recipient, content: reviewed.text, attachments: link.attachments, revision: link.revision, coreReviewDigest: reviewed.reviewDigest, ...(link.commercialContext !== undefined ? { commercialContext: link.commercialContext } : {}), ...(link.supplyContext !== undefined ? { supplyContext: link.supplyContext } : {}) });
}
export const officePilotPolicy = {
  teamId: 'T_OFFICE_DEMO', acceptanceTimeoutMs: 10_000, maxCapacity: 1,
  actors: { [DEMO_ACTOR]: { closerId: DEMO_ACTOR, roles: ['sales', 'finance'], eventIds: [...CASE_IDS], departmentIds: ['sales'] } },
  threadBindings: CASE_IDS.map((gourmetEventId, index) => ({ channelId: 'C_OFFICE_DEMO', threadTs: `1000000000.00000${index + 1}`, gourmetEventId })),
  paymentProviders: ['OFFICE_FIXTURE_PAYMENTS'],
  catalog: { version: 'OFFICE_DEMO_CATALOG_V1', items: { buffet: { label: 'Menú ilustrativo DEMO', unitPriceCents: 3500 } } },
};
export async function runPilotCommand(state: OfficeState, caseId: DemoCaseId, operation: string, input: object, commandId: string, atMs: number, explicitApproval = false) {
  // This view participates in the caller's existing PostgreSQL transaction.
  // It deliberately does not obtain a second lock or commit independently.
  const transactionalView: OfficeStore = { transact: async fn => fn(state), snapshot: async () => structuredClone(state) };
  const adapter = pilotCore.createPilotAdapter({ store: transactionalView, mode: 'simulation', policy: officePilotPolicy, clock: () => atMs });
  const binding = officePilotPolicy.threadBindings.find(row => row.gourmetEventId === caseId)!;
  return adapter.execute({ schemaVersion: 1, source: 'slack_simulation', sourceId: 'OFFICE_DEMO_LOCAL_UI', sourceEventId: commandId, actorId: DEMO_ACTOR, gourmetEventId: caseId, operation, input, teamId: officePilotPolicy.teamId, channelId: binding.channelId, threadTs: binding.threadTs }, { authenticatedActorId: DEMO_ACTOR, simulation: true, explicitApproval });
}
