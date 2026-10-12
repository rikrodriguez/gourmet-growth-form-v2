import type { MondayAllowedColumn, MondayBoardId, MondayCommercialField, MondayReadItem, MondayReadReason, MondayReadResult } from './backend/monday-read';
import { getMondayBoardCapabilities, MONDAY_BOARD_CATALOG, MONDAY_COMMERCIAL_FIELDS } from './monday-board-catalog';
import type { MondayBoardCapability } from './monday-board-catalog';

export type MondayFieldAvailability = { field: MondayCommercialField; availability: 'available' | 'empty' | 'redacted' | 'not_queried'; text: string | null; columnId?: string };
export type MondayReadCoverage = {
  source: 'monday'; boardId: MondayBoardId; mappingVersion: string;
  status: MondayReadResult<unknown>['status']; reason: MondayReadReason | null;
  readAt: string; pages: number; itemsRead: number; totalItems: null;
};

const READ_REASONS: readonly MondayReadReason[] = Object.freeze(['disabled', 'invalid_request', 'forbidden_board', 'scopes_mismatch', 'expired', 'columns_unconfigured', 'incompatible', 'unauthorized', 'forbidden', 'rate_limited', 'provider_partial', 'offline', 'aborted', 'cursor_expired', 'cursor_cycle', 'page_limit', 'updates_limit']);
function fail(): never { throw new Error('Invalid Monday provenance contract.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value as Record<string, unknown>;
}
function keys(row: Record<string, unknown>, required: readonly string[]) {
  if (Object.keys(row).length !== required.length || required.some(key => !Object.hasOwn(row, key))) fail();
}
function sourceId(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value); }
function sourceDate(value: unknown, timestamp = false): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)) || timestamp && !value.includes('T')) return false;
  if (value.includes('T') && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) return false;
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}
function safeArray(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) fail();
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value;
}
function validatedCapability(value: MondayBoardCapability): MondayBoardCapability {
  const row = record(value); keys(row, ['id', 'name', 'nameVerifiedOn', 'mappingVersion', 'commercialRead', 'updatesRead']);
  const commercial = record(row.commercialRead); keys(commercial, ['enabled', 'reason', 'columns']);
  const updates = record(row.updatesRead); keys(updates, ['enabled', 'reason']);
  if (typeof updates.enabled !== 'boolean' || typeof commercial.enabled !== 'boolean' || !MONDAY_BOARD_CATALOG.some(board => board.id === row.id)) fail();
  let expected: MondayBoardCapability | undefined;
  try { expected = getMondayBoardCapabilities({ [row.id as string]: commercial.columns as readonly MondayAllowedColumn[] }, row.mappingVersion as string, updates.enabled).find(board => board.id === row.id); } catch { fail(); }
  if (!expected || row.name !== expected.name || row.nameVerifiedOn !== expected.nameVerifiedOn || commercial.enabled !== expected.commercialRead.enabled || commercial.reason !== expected.commercialRead.reason || updates.reason !== expected.updatesRead.reason) fail();
  if (row.id === '18411103560' && safeArray(commercial.columns).length) fail();
  return expected;
}
function projectedText(row: Record<string, unknown>, column: MondayAllowedColumn): { availability: 'available' | 'empty' | 'redacted'; text: string | null } {
  if (typeof row.redacted !== 'boolean' || row.text !== null && (typeof row.text !== 'string' || row.text.length > 160 || /[\u0000-\u001f\u007f]/.test(row.text))) fail();
  if (row.redacted) { if (row.text !== null) fail(); return { availability: 'redacted', text: null }; }
  const text = row.text === null ? null : (row.text as string).trim() || null;
  if (text !== null) {
    if (column.type === 'numbers') {
      if (!/^-?[0-9]{1,12}(?:\.[0-9]{1,4})?$/.test(text)) fail();
      if (column.field === 'guest_count' && (!Number.isSafeInteger(Number(text)) || Number(text) < 0 || Number(text) > 1_000_000)) fail();
    } else if (column.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || !sourceDate(text)) fail();
    } else if (/@|https?:\/\/|www\.|(?:\+?\d[\s().-]*){7,}|(?:bearer|token|secret|password|api[_ -]?key)\s*[:=]|[<>]|[A-Za-z0-9_-]{32,}/i.test(text)) fail();
  }
  return { availability: text === null ? 'empty' : 'available', text };
}

export function getMondayItemAvailability(item: MondayReadItem, capability: MondayBoardCapability): readonly MondayFieldAvailability[] {
  const cap = validatedCapability(capability); const row = record(item);
  keys(row, ['id', 'boardId', 'sourceUpdatedAt', 'readAt', 'columns']);
  if (row.boardId !== cap.id || cap.id === '18411103560' || !sourceId(row.id) || !sourceDate(row.readAt, true) || row.sourceUpdatedAt !== null && !sourceDate(row.sourceUpdatedAt)) fail();
  const received = safeArray(row.columns); const mapped = cap.commercialRead.columns;
  if (received.length !== mapped.length) fail();
  const values = new Map<MondayCommercialField, MondayFieldAvailability>();
  for (const value of received) {
    const column = record(value); keys(column, ['id', 'field', 'type', 'text', 'redacted']);
    const allowed = mapped.find(entry => entry.id === column.id);
    if (!allowed || allowed.field !== column.field || allowed.type !== column.type || values.has(allowed.field)) fail();
    values.set(allowed.field, Object.freeze({ field: allowed.field, ...projectedText(column, allowed), columnId: allowed.id }));
  }
  return Object.freeze(MONDAY_COMMERCIAL_FIELDS.map(field => values.get(field) ?? Object.freeze({ field, availability: 'not_queried' as const, text: null })));
}

export function getMondayReadCoverage(result: MondayReadResult<unknown>): MondayReadCoverage {
  const row = record(result);
  if (!MONDAY_BOARD_CATALOG.some(board => board.id === row.boardId) || typeof row.mappingVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(row.mappingVersion)
    || !['complete', 'partial', 'blocked'].includes(row.status as string) || !sourceDate(row.readAt, true) || !Number.isSafeInteger(row.pages) || (row.pages as number) < 0 || (row.pages as number) > 40) fail();
  const items = safeArray(row.items);
  const reason = row.reason === undefined ? null : row.reason;
  if (reason !== null && !READ_REASONS.includes(reason as MondayReadReason) || items.length > Math.min(1000, (row.pages as number) * 25)
    || row.status === 'blocked' && ((row.pages as number) !== 0 || items.length !== 0 || reason === null)
    || row.status === 'partial' && reason === null || row.status === 'complete' && (reason !== null || row.pages === 0)) fail();
  // Completion is scoped to this read of this board; Monday's total is unknown.
  // Only count projected items. Never copy item content or continuation internals.
  return Object.freeze({ source: 'monday', boardId: row.boardId as MondayBoardId, mappingVersion: row.mappingVersion, status: row.status as MondayReadCoverage['status'], reason: reason as MondayReadReason | null, readAt: row.readAt, pages: row.pages as number, itemsRead: items.length, totalItems: null });
}
