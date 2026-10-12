import type { MondayAllowedColumn, MondayBoardId, MondayColumnAllowlist, MondayCommercialField } from './backend/monday-read';

export const MONDAY_COMMERCIAL_FIELDS = Object.freeze(['stage', 'event_type', 'guest_count', 'event_date', 'service_style', 'amount', 'quote_status'] as const satisfies readonly MondayCommercialField[]);

// Names verified from the connected metadata read on 2026-10-12. The catalog
// describes metadata only; it never supplies or expands a commercial mapping.
export const MONDAY_BOARD_CATALOG = Object.freeze([
  Object.freeze({ id: '18403945258', name: 'Lead Management', nameVerifiedOn: '2026-10-12' }),
  Object.freeze({ id: '18411103560', name: 'Deals', nameVerifiedOn: '2026-10-12' }),
  Object.freeze({ id: '18398057136', name: 'Catering Funnel', nameVerifiedOn: '2026-10-12' }),
  Object.freeze({ id: '18396813878', name: 'Catering Form', nameVerifiedOn: '2026-10-12' }),
  Object.freeze({ id: '18377848804', name: 'Quotes & Invoices', nameVerifiedOn: '2026-10-12' }),
] as const);

export type MondayBoardCapability = {
  id: MondayBoardId;
  name: string;
  nameVerifiedOn: '2026-10-12';
  mappingVersion: string;
  commercialRead: { enabled: boolean; reason: 'disabled' | 'forbidden_board' | 'columns_unconfigured' | null; columns: readonly MondayAllowedColumn[] };
  updatesRead: { enabled: boolean; reason: 'disabled' | 'forbidden_board' | null };
};

const FIELD_TYPES: Record<MondayCommercialField, readonly MondayAllowedColumn['type'][]> = {
  stage: ['status', 'dropdown'], event_type: ['status', 'dropdown'], guest_count: ['numbers'],
  event_date: ['date'], service_style: ['status', 'dropdown'], amount: ['numbers'], quote_status: ['status', 'dropdown'],
};
function fail(): never { throw new Error('Invalid Monday capabilities contract.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail();
  }
  return value as Record<string, unknown>;
}
function columns(value: unknown): readonly MondayAllowedColumn[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 20 || Reflect.ownKeys(value).length !== value.length + 1) fail();
  const parsed: MondayAllowedColumn[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
    const row = record(descriptor.value);
    if (Object.keys(row).length !== 3 || !['id', 'field', 'type'].every(key => Object.hasOwn(row, key))) fail();
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9_]{1,96}$/.test(row.id) || ['__proto__', 'prototype', 'constructor'].includes(row.id)
      || typeof row.field !== 'string' || !Object.hasOwn(FIELD_TYPES, row.field) || !FIELD_TYPES[row.field as MondayCommercialField].includes(row.type as MondayAllowedColumn['type'])) fail();
    parsed.push(Object.freeze({ id: row.id, type: row.type as MondayAllowedColumn['type'], field: row.field as MondayCommercialField }));
  }
  if (new Set(parsed.map(column => column.id)).size !== parsed.length || new Set(parsed.map(column => column.field)).size !== parsed.length) fail();
  return Object.freeze(parsed);
}

export function getMondayBoardCapabilities(mapping: MondayColumnAllowlist, mappingVersion: string, enabled: boolean): readonly MondayBoardCapability[] {
  if (typeof mappingVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(mappingVersion) || typeof enabled !== 'boolean') fail();
  const raw = record(mapping); const validated = new Map<MondayBoardId, readonly MondayAllowedColumn[]>();
  for (const [id, value] of Object.entries(raw)) {
    if (!MONDAY_BOARD_CATALOG.some(board => board.id === id)) fail();
    validated.set(id as MondayBoardId, columns(value));
  }
  return Object.freeze(MONDAY_BOARD_CATALOG.map(board => {
    const forbidden = board.id === '18411103560';
    const mapped = forbidden ? Object.freeze([] as MondayAllowedColumn[]) : validated.get(board.id) ?? Object.freeze([] as MondayAllowedColumn[]);
    const reason = forbidden ? 'forbidden_board' : !enabled ? 'disabled' : !mapped.length ? 'columns_unconfigured' : null;
    return Object.freeze({
      ...board, mappingVersion,
      commercialRead: Object.freeze({ enabled: reason === null, reason, columns: mapped }),
      updatesRead: Object.freeze({ enabled: enabled && !forbidden, reason: forbidden ? 'forbidden_board' : !enabled ? 'disabled' : null }),
    });
  }));
}
