import { createMondayClient } from './monday-client';

const token = process.env.MONDAY_API_TOKEN;
const boardId = process.env.MONDAY_BOARD_ID ?? '18403945258';
const groupId = process.env.MONDAY_GROUP_ID;
if (!token) throw new Error('MONDAY_API_TOKEN is required.');
if (!groupId) throw new Error('MONDAY_GROUP_ID is required.');
const result = await createMondayClient({ token, boardId, groupId }).preflight();
process.stdout.write(`${JSON.stringify({ status: 'pass', ...result })}\n`);

