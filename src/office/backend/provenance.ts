import type { FastifyRequest } from 'fastify';
import type { BridgePartition, BridgeSnapshot } from '../canonical-bridge-contracts';
import type { BridgeReadModel, DemoProvenance, MondayProvenance } from '../provenance-contracts';
import { validateBridgeSnapshot, validateDemoProvenance, validateMondayProvenance } from '../provenance-contracts';
import type { OfficeSnapshot } from '../contracts';
import type { DevelopmentSession } from './session';
import type { MondayOAuthStatus } from './monday-oauth';
import { CASE_IDS, FUNCTION_IDS, OfficeError } from './state';

// Only a trusted server composition root may bind the store's organization and
// actor. Requests never select a workspace, partition or source.
export type OfficeProvenanceOptions = {
  demoBridge?: { read: (session: DevelopmentSession) => Promise<BridgeSnapshot | null> };
};
export type ProvenanceOptions = OfficeProvenanceOptions;
export function assertProvenanceRequest(request: FastifyRequest) {
  if (request.url.includes('?') || request.body !== undefined || request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0' || request.headers['transfer-encoding'] !== undefined) throw new OfficeError('INVALID_PROVENANCE_REQUEST');
}
export function unqueriedBridge(partition: BridgePartition, state: 'unconfigured' | 'unavailable' | 'scope_restricted' = 'unconfigured'): BridgeReadModel {
  return { state, partition, storage: null, revision: null, sourceVersions: [], bindings: [], importsEnabled: false, automaticLinking: false, metricsConsumed: false, coverage: 'not_queried' };
}
async function demoBridge(session: DevelopmentSession, options?: OfficeProvenanceOptions): Promise<BridgeReadModel> {
  // DEMO actors are shared across session scopes. A global bridge projection
  // would leak excluded cases/functions until explicit bridge-case ACLs exist.
  if (session.caseIds.length !== CASE_IDS.length || CASE_IDS.some(id => !session.caseIds.includes(id)) || session.functionIds.length !== FUNCTION_IDS.length || FUNCTION_IDS.some(id => !session.functionIds.includes(id))) return unqueriedBridge('demo', 'scope_restricted');
  if (!options?.demoBridge) return unqueriedBridge('demo');
  try {
    const raw = await options.demoBridge.read(structuredClone(session));
    if (raw === null) return unqueriedBridge('demo', 'unavailable');
    const snapshot = validateBridgeSnapshot(raw);
    if (snapshot.scope.actorId !== session.actorId || snapshot.scope.partition !== 'demo') return unqueriedBridge('demo', 'unavailable');
    const sourceVersions = snapshot.sourceVersions.slice(0, 50); const bindings = snapshot.bindings.slice(0, 50);
    return { state: sourceVersions.length || bindings.length ? 'available' : 'empty', partition: 'demo', storage: 'postgres', revision: snapshot.revision, sourceVersions, bindings, importsEnabled: false, automaticLinking: false, metricsConsumed: false, coverage: snapshot.sourceVersions.length > 50 || snapshot.bindings.length > 50 ? 'partial' : 'complete' };
  } catch { return unqueriedBridge('demo', 'unavailable'); }
}
export async function projectDemoProvenance(snapshot: OfficeSnapshot, session: DevelopmentSession, readAt: string, options?: OfficeProvenanceOptions): Promise<DemoProvenance> {
  if (snapshot.mode !== 'demo') throw new OfficeError('INVALID_PROVENANCE_STATE', 503);
  return validateDemoProvenance({ schemaVersion: 1, source: 'demo', synthetic: true, readAt,
    coverage: { caseIds: [...session.caseIds], functionIds: [...session.functionIds] },
    // Keep provenance only. Titles, contacts, commercial values and message
    // bodies from the scoped Office projection never reach this DTO.
    officeEvidence: snapshot.cases.map(row => ({ caseId: row.id, source: row.evidence.source, reference: row.evidence.reference, observedAt: row.evidence.at, simulated: row.evidence.simulated })),
    bridge: await demoBridge(session, options),
  });
}
export function projectMondayProvenance(status: MondayOAuthStatus, readAt: string): MondayProvenance {
  return validateMondayProvenance({ schemaVersion: 1, source: 'monday', synthetic: false, readAt,
    connection: { state: status.state, configured: true, boardAccessVerified: status.boardAccessVerified, identityReadAt: status.identityReadAt, lastReadAt: status.lastReadAt, expiresAt: status.expiresAt },
    // Configured account IDs are not verified organization authority. No Monday
    // bridge is selected or queried until that binding is decided explicitly.
    bridge: unqueriedBridge('external'),
  });
}
