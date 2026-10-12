import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MondayAllowedColumn, MondayColumnAllowlist, MondayReadItem, MondayReadResult } from '../../src/office/backend/monday-read';
import type { MondayBoardCapability } from '../../src/office/monday-board-catalog';
import * as catalog from '../../src/office/monday-board-catalog';
import * as provenance from '../../src/office/monday-provenance';

function capabilities() { return catalog; }
function helpers() { return provenance; }
const BOARD = '18403945258' as const;
const DEALS = '18411103560' as const;
const AT = '2026-10-12T03:20:00.000Z';
const VERSION = 'synthetic-mapping-v1';
function mapping(): MondayColumnAllowlist { return { [BOARD]: [{ id: 'status', type: 'status', field: 'stage' }, { id: 'amount', type: 'numbers', field: 'amount' }, { id: 'quote', type: 'dropdown', field: 'quote_status' }] }; }
function capability(): MondayBoardCapability { return capabilities().getMondayBoardCapabilities(mapping(), VERSION, true)[0]; }
function item(): MondayReadItem { return { id: '100001', boardId: BOARD, sourceUpdatedAt: '2026-10-12T03:00:00.000Z', readAt: AT, columns: [{ id: 'status', type: 'status', field: 'stage', text: 'Conversion', redacted: false }, { id: 'amount', type: 'numbers', field: 'amount', text: null, redacted: false }, { id: 'quote', type: 'dropdown', field: 'quote_status', text: 'Enviada', redacted: false }] }; }
function result(): MondayReadResult<MondayReadItem> { return { boardId: BOARD, mappingVersion: VERSION, readAt: AT, status: 'partial', reason: 'page_limit', pages: 4, items: [item()] }; }
const safeFailure = (error: unknown) => error instanceof Error && /^Invalid Monday (capabilities|provenance) contract\.$/.test(error.message);

describe('Monday board capabilities', () => {
  it('freezes exactly the five verified names and seven existing fields', () => {
    const api = capabilities();
    assert.deepEqual(api.MONDAY_BOARD_CATALOG, [
      { id: BOARD, name: 'Lead Management', nameVerifiedOn: '2026-10-12' },
      { id: DEALS, name: 'Deals', nameVerifiedOn: '2026-10-12' },
      { id: '18398057136', name: 'Catering Funnel', nameVerifiedOn: '2026-10-12' },
      { id: '18396813878', name: 'Catering Form', nameVerifiedOn: '2026-10-12' },
      { id: '18377848804', name: 'Quotes & Invoices', nameVerifiedOn: '2026-10-12' },
    ]);
    assert.deepEqual(api.MONDAY_COMMERCIAL_FIELDS, ['stage', 'event_type', 'guest_count', 'event_date', 'service_style', 'amount', 'quote_status']);
    assert(Object.isFrozen(api.MONDAY_COMMERCIAL_FIELDS)); assert(Object.isFrozen(api.MONDAY_BOARD_CATALOG));
    api.MONDAY_BOARD_CATALOG.forEach(board => assert(Object.isFrozen(board)));
  });
  it('derives commercial capability solely from supplied mapping while permitting update metadata', () => {
    const boards = capabilities().getMondayBoardCapabilities(mapping(), VERSION, true);
    assert.equal(boards.length, 5);
    assert.deepEqual(boards[0], { id: BOARD, name: 'Lead Management', nameVerifiedOn: '2026-10-12', mappingVersion: VERSION, commercialRead: { enabled: true, reason: null, columns: mapping()[BOARD] }, updatesRead: { enabled: true, reason: null } });
    for (const board of boards.slice(2)) {
      assert.deepEqual(board.commercialRead, { enabled: false, reason: 'columns_unconfigured', columns: [] });
      assert.deepEqual(board.updatesRead, { enabled: true, reason: null });
    }
  });
  it('keeps Deals forbidden even when configured or disabled', () => {
    for (const enabled of [true, false]) {
      const deals = capabilities().getMondayBoardCapabilities({ [DEALS]: mapping()[BOARD] }, VERSION, enabled)[1];
      assert.deepEqual(deals.commercialRead, { enabled: false, reason: 'forbidden_board', columns: [] });
      assert.deepEqual(deals.updatesRead, { enabled: false, reason: 'forbidden_board' });
    }
  });
  it('blocks disabled reads and retains only the supplied mapping snapshot', () => {
    const boards = capabilities().getMondayBoardCapabilities(mapping(), VERSION, false);
    assert.deepEqual(boards[0].commercialRead, { enabled: false, reason: 'disabled', columns: mapping()[BOARD] });
    for (const board of boards.filter(board => board.id !== DEALS)) assert.deepEqual(board.updatesRead, { enabled: false, reason: 'disabled' });
  });
  it('treats empty and omitted arrays as unconfigured without embedding a live mapping', () => {
    for (const input of [{}, { [BOARD]: [] }]) {
      const boards = capabilities().getMondayBoardCapabilities(input, VERSION, true);
      assert.equal(boards[0].commercialRead.reason, 'columns_unconfigured');
      assert.deepEqual(boards[0].commercialRead.columns, []);
    }
  });
  it('copies and deeply freezes capabilities without freezing or changing caller mapping', () => {
    const input = mapping(); const original = structuredClone(input);
    const boards = capabilities().getMondayBoardCapabilities(input, VERSION, true);
    assert.deepEqual(input, original); assert(!Object.isFrozen(input));
    (input[BOARD]![0] as MondayAllowedColumn).id = 'changed';
    assert.equal(boards[0].commercialRead.columns[0].id, 'status');
    assert(Object.isFrozen(boards)); assert(Object.isFrozen(boards[0]));
    assert(Object.isFrozen(boards[0].commercialRead)); assert(Object.isFrozen(boards[0].commercialRead.columns));
    assert(Object.isFrozen(boards[0].commercialRead.columns[0])); assert(Object.isFrozen(boards[0].updatesRead));
  });
  it('rejects unknown boards, unsafe or duplicate columns, broadened fields and invalid field types', () => {
    const invalid = [{ unknown: [] }, { [BOARD]: null }, { [BOARD]: [mapping()[BOARD]![0], mapping()[BOARD]![0]] },
      { [BOARD]: [{ id: 'other', field: 'stage', type: 'status' }, mapping()[BOARD]![0]] },
      { [BOARD]: [{ id: '__proto__', field: 'stage', type: 'status' }] },
      { [BOARD]: [{ id: 'status', field: 'contact_email', type: 'status' }] },
      { [BOARD]: [{ id: 'amount', field: 'amount', type: 'status' }] },
      { [BOARD]: [{ ...mapping()[BOARD]![0], privateData: 'synthetic-private' }] }];
    for (const value of invalid) assert.throws(() => capabilities().getMondayBoardCapabilities(value as MondayColumnAllowlist, VERSION, true), safeFailure);
  });
  it('rejects malformed versions, enabled flags, prototypes and accessor contracts safely', () => {
    const api = capabilities();
    for (const version of ['', 'private version', 'x'.repeat(97)]) assert.throws(() => api.getMondayBoardCapabilities({}, version, true), safeFailure);
    assert.throws(() => api.getMondayBoardCapabilities({}, VERSION, 'true' as unknown as boolean), safeFailure);
    assert.throws(() => api.getMondayBoardCapabilities(Object.create({ [BOARD]: [] }), VERSION, true), safeFailure);
    let accesses = 0; const input = Object.defineProperty({}, BOARD, { enumerable: true, get() { accesses++; return []; } });
    assert.throws(() => api.getMondayBoardCapabilities(input, VERSION, true), safeFailure); assert.equal(accesses, 0);
  });
  it('rejects array subclasses rather than executing caller-controlled traversal', () => {
    class ForeignColumns extends Array<MondayAllowedColumn> {}
    const foreign = new ForeignColumns(mapping()[BOARD]![0]);
    assert.throws(() => capabilities().getMondayBoardCapabilities({ [BOARD]: foreign }, VERSION, true), safeFailure);
  });
});

describe('Monday field provenance', () => {
  it('returns all seven fields and preserves labels without inferring payment or document events', () => {
    const availability = helpers().getMondayItemAvailability(item(), capability());
    assert.deepEqual(availability, [
      { field: 'stage', availability: 'available', text: 'Conversion', columnId: 'status' },
      { field: 'event_type', availability: 'not_queried', text: null },
      { field: 'guest_count', availability: 'not_queried', text: null },
      { field: 'event_date', availability: 'not_queried', text: null },
      { field: 'service_style', availability: 'not_queried', text: null },
      { field: 'amount', availability: 'empty', text: null, columnId: 'amount' },
      { field: 'quote_status', availability: 'available', text: 'Enviada', columnId: 'quote' },
    ]);
    assert(!/paid|payment|sentDocument|DEMO/.test(JSON.stringify(availability)));
    assert(Object.isFrozen(availability)); availability.forEach(field => assert(Object.isFrozen(field)));
  });
  it('distinguishes null and whitespace from redacted and unqueried values', () => {
    for (const text of [null, '', '   ']) {
      const row = item(); row.columns[1].text = text;
      assert.deepEqual(helpers().getMondayItemAvailability(row, capability())[5], { field: 'amount', availability: 'empty', text: null, columnId: 'amount' });
    }
    const row = item(); row.columns[0] = { ...row.columns[0], text: null, redacted: true };
    assert.deepEqual(helpers().getMondayItemAvailability(row, capability())[0], { field: 'stage', availability: 'redacted', text: null, columnId: 'status' });
  });
  it('preserves textual zero as available and never supplies currency or payment claims', () => {
    const row = item(); row.columns[1].text = '0';
    assert.deepEqual(helpers().getMondayItemAvailability(row, capability())[5], { field: 'amount', availability: 'available', text: '0', columnId: 'amount' });
  });
  it('returns every field as unqueried for an empty mapping and empty projection', () => {
    const cap = capabilities().getMondayBoardCapabilities({}, VERSION, true)[0];
    const row = item(); row.columns = [];
    const availability = helpers().getMondayItemAvailability(row, cap);
    assert.equal(availability.length, 7); assert(availability.every(value => value.availability === 'not_queried' && value.text === null && !Object.hasOwn(value, 'columnId')));
  });
  it('rejects mismatched boards, missing, duplicate and unknown columns instead of coercing', () => {
    const row = item(); const cap = capability();
    for (const invalid of [{ ...row, boardId: DEALS }, { ...row, columns: row.columns.slice(1) }, { ...row, columns: [...row.columns, row.columns[0]] },
      { ...row, columns: [{ ...row.columns[0], id: 'unmapped' }, ...row.columns.slice(1)] },
      { ...row, columns: [{ ...row.columns[0], field: 'amount' }, ...row.columns.slice(1)] },
      { ...row, columns: [{ ...row.columns[0], type: 'numbers' }, ...row.columns.slice(1)] }]) {
      assert.throws(() => helpers().getMondayItemAvailability(invalid as MondayReadItem, cap), safeFailure);
    }
  });
  it('rejects incompatible source formats, redacted content, contact labels and unexpected fields', () => {
    const row = item(); const cap = capability();
    const columns = [{ ...row.columns[0], text: 10 }, { ...row.columns[0], text: 'private@example.invalid' },
      { ...row.columns[0], text: 'hidden', redacted: true }, { ...row.columns[0], redacted: 'true' },
      { ...row.columns[1], text: 'EUR 200' }, { ...row.columns[0], raw: 'synthetic-private' }];
    for (const column of columns) {
      const index = column.id === 'amount' ? 1 : 0; const invalid = item(); invalid.columns[index] = column as MondayReadItem['columns'][number];
      assert.throws(() => helpers().getMondayItemAvailability(invalid, cap), safeFailure);
    }
    for (const invalid of [{ ...row, name: 'synthetic-private' }, { ...row, readAt: 'bad-date' }, { ...row, id: 100001 }]) assert.throws(() => helpers().getMondayItemAvailability(invalid as MondayReadItem, cap), safeFailure);
  });
  it('rejects forged capabilities with invalid names, metadata, permissions or forbidden reads', () => {
    const cap = capability(); const row = item();
    for (const invalid of [{ ...cap, name: 'Other board' }, { ...cap, nameVerifiedOn: '2026-10-11' }, { ...cap, mappingVersion: '' },
      { ...cap, commercialRead: { ...cap.commercialRead, reason: 'columns_unconfigured' } },
      { ...cap, updatesRead: { enabled: true, reason: 'disabled' } },
      { ...cap, privateData: 'synthetic-private' }]) assert.throws(() => helpers().getMondayItemAvailability(row, invalid as MondayBoardCapability), safeFailure);
    const deals = capabilities().getMondayBoardCapabilities({}, VERSION, true)[1];
    assert.throws(() => helpers().getMondayItemAvailability({ ...row, boardId: DEALS, columns: [] }, deals), safeFailure);
  });
  it('rejects nonstandard item arrays before using their iterator', () => {
    class ForeignColumns extends Array<MondayReadItem['columns'][number]> {}
    const row = item(); row.columns = new ForeignColumns(...row.columns);
    assert.throws(() => helpers().getMondayItemAvailability(row, capability()), safeFailure);
  });
});

describe('Monday read coverage', () => {
  it('preserves partial board coverage and keeps the board total unknown', () => {
    const coverage = helpers().getMondayReadCoverage(result());
    assert.deepEqual(coverage, { source: 'monday', boardId: BOARD, mappingVersion: VERSION, status: 'partial', reason: 'page_limit', readAt: AT, pages: 4, itemsRead: 1, totalItems: null });
    assert(Object.isFrozen(coverage));
  });
  it('keeps complete and blocked results scoped to one board with unknown totals', () => {
    assert.deepEqual(helpers().getMondayReadCoverage({ ...result(), status: 'complete', reason: undefined }), { source: 'monday', boardId: BOARD, mappingVersion: VERSION, status: 'complete', reason: null, readAt: AT, pages: 4, itemsRead: 1, totalItems: null });
    assert.deepEqual(helpers().getMondayReadCoverage({ ...result(), boardId: DEALS, status: 'blocked', reason: 'forbidden_board', pages: 0, items: [] }), { source: 'monday', boardId: DEALS, mappingVersion: VERSION, status: 'blocked', reason: 'forbidden_board', readAt: AT, pages: 0, itemsRead: 0, totalItems: null });
  });
  it('copies only summary fields and never serializes item values, provider cursors or paging internals', () => {
    const source = { ...result(), cursor: 'synthetic-private-cursor', accessToken: 'synthetic-private-token', paging: { nextBatch: 'opaque' } };
    const coverage = helpers().getMondayReadCoverage(source);
    assert(!/synthetic-private|Conversion|Enviada|cursor|accessToken|paging/.test(JSON.stringify(coverage)));
  });
  it('rejects malformed or inconsistent coverage without leaking caller data', () => {
    for (const value of [{ ...result(), boardId: 'unknown' }, { ...result(), status: 'office_complete' }, { ...result(), reason: 'synthetic-private-reason' },
      { ...result(), readAt: 'invalid' }, { ...result(), pages: -1 }, { ...result(), pages: 1.5 }, { ...result(), pages: 0 },
      { ...result(), items: null }, { ...result(), status: 'blocked' }, { ...result(), status: 'partial', reason: undefined }]) {
      assert.throws(() => helpers().getMondayReadCoverage(value as MondayReadResult<unknown>), safeFailure);
    }
  });
  it('rejects nonstandard coverage arrays while counting only valid projected collections', () => {
    class ForeignItems extends Array<MondayReadItem> {}
    assert.throws(() => helpers().getMondayReadCoverage({ ...result(), items: new ForeignItems(item()) }), safeFailure);
  });
});
