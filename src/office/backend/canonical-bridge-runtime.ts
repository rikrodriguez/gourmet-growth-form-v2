import type { Pool } from 'pg';
import type { BridgeSnapshot } from '../canonical-bridge-contracts';
import type { DevelopmentSession } from './session';
import { CanonicalBridge, CanonicalBridgeError } from './canonical-bridge';
import { PostgresCanonicalBridgeStore } from './canonical-bridge-postgres';
import { CASE_IDS, DEMO_ACTOR, FUNCTION_IDS } from './state';

// The organization here is exclusively the existing synthetic Office state
// namespace. It is never inferred from an external account or request. No
// external source is selected and no record is seeded/imported by this provider.
export function createDemoBridgeProvenanceProvider(pool: Pool, stateId: string, options: { schema?: string } = {}): { read(session: DevelopmentSession): Promise<BridgeSnapshot> } {
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(stateId)) throw new CanonicalBridgeError('BRIDGE_INVALID_SCOPE');
  const sources = [{ sourceSystem: 'fixture:office', partition: 'demo' }] as const;
  const bridge = new CanonicalBridge(new PostgresCanonicalBridgeStore(pool, { sources, schema: options.schema }), { sources });
  return { async read(session) {
    if (session.mode !== 'demo' || session.actorId !== DEMO_ACTOR || session.caseIds.length !== CASE_IDS.length || CASE_IDS.some(id => !session.caseIds.includes(id)) || session.functionIds.length !== FUNCTION_IDS.length || FUNCTION_IDS.some(id => !session.functionIds.includes(id))) throw new CanonicalBridgeError('BRIDGE_FORBIDDEN_SCOPE');
    return bridge.snapshot({ organizationId: stateId, actorId: session.actorId, partition: 'demo' });
  } };
}
