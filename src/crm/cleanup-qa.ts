import pg from 'pg';
import { createMondayClient } from './monday-client';

const leadId = process.argv[2];
if (!leadId || !/^[0-9a-f-]{36}$/i.test(leadId) || !process.argv.includes('--confirm')) {
  throw new Error('Usage: npm run crm:cleanup:qa -- <lead-id> --confirm');
}
const databaseUrl = process.env.MIGRATION_DATABASE_URL;
const token = process.env.MONDAY_API_TOKEN;
const boardId = process.env.MONDAY_BOARD_ID ?? '18403945258';
const groupId = process.env.MONDAY_GROUP_ID;
if (!databaseUrl || !token || !groupId) throw new Error('CRM cleanup environment is incomplete.');
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  const lead = await client.query(`SELECT is_qa,monday_item_id FROM growth_v2.leads WHERE lead_id=$1 AND deleted_at IS NULL`, [leadId]);
  if (!lead.rowCount || lead.rows[0].is_qa !== true || lead.rows[0].monday_item_id === null) throw new Error('qa_lead_not_eligible');
  const monday = createMondayClient({ token, boardId, groupId });
  const item = await monday.getItem(String(lead.rows[0].monday_item_id));
  if (!item || !item.name.startsWith('[QA] ')) throw new Error('qa_item_identity_mismatch');
  await monday.archiveItem(item.id, `qa-cleanup:${leadId}`);
  await client.query('BEGIN');
  await client.query('DELETE FROM growth_v2.events WHERE session_id=(SELECT session_id FROM growth_v2.leads WHERE lead_id=$1)', [leadId]);
  await client.query('DELETE FROM growth_v2.leads WHERE lead_id=$1 AND is_qa=true', [leadId]);
  await client.query(`DELETE FROM growth_v2.sessions s WHERE s.is_qa=true AND NOT EXISTS(SELECT 1 FROM growth_v2.leads l WHERE l.session_id=s.session_id) AND NOT EXISTS(SELECT 1 FROM growth_v2.events e WHERE e.session_id=s.session_id)`);
  await client.query(`DELETE FROM growth_v2.visitors v WHERE NOT EXISTS(SELECT 1 FROM growth_v2.sessions s WHERE s.visitor_id=v.visitor_id) AND NOT EXISTS(SELECT 1 FROM growth_v2.leads l WHERE l.visitor_id=v.visitor_id) AND NOT EXISTS(SELECT 1 FROM growth_v2.events e WHERE e.visitor_id=v.visitor_id)`);
  await client.query('COMMIT');
  process.stdout.write(`${JSON.stringify({ status: 'cleaned', lead_id: leadId, monday_item_id: item.id })}\n`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally { await client.end(); }

