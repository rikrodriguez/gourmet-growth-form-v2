/** New OS process; only isolated loopback fixture state and existing synthetic proof. */
import { Pool } from 'pg';
import { DEFAULT_OFFICE_DATABASE_URL } from '../../src/office/backend/postgres-store';
import { createDurableTestProposalService } from '../../src/office/backend/external-proposal-durable';
import { durableProposalProof, proposalVault } from './external-proposal-durable-fixtures';
const config = JSON.parse(process.argv[2]);
const pool = new Pool({ connectionString: DEFAULT_OFFICE_DATABASE_URL, connectionTimeoutMillis: 1000 });
try {
 const service = createDurableTestProposalService({ ...config, pool, vault: proposalVault(), clock: () => config.at });
 const history = await service.history(durableProposalProof), view = await service.read(durableProposalProof);
 const replay = await service.execute(durableProposalProof, config.command);
 process.stdout.write(JSON.stringify({ history, view, replay }));
} finally { await pool.end(); }
