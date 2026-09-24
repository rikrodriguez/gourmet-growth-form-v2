import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeCursor, encodeCursor, parseListFilters, parseReportingRange } from '../../src/dashboard/filters';

describe('dashboard filters', () => {
  const now = new Date('2026-03-08T20:00:00.000Z');

  it('uses explicit America/Los_Angeles boundaries across DST', () => {
    const today = parseReportingRange({ range: 'today' }, now);
    assert.equal(today.timezone, 'America/Los_Angeles');
    assert.equal(today.from.toISOString(), '2026-03-08T08:00:00.000Z');
    assert.equal(today.to.toISOString(), '2026-03-09T07:00:00.000Z');
  });

  it('caps range, page size, allowlisted statuses, and steps', () => {
    assert.throws(() => parseReportingRange({ range: 'custom', from: '2020-01-01', to: '2026-01-01' }, now));
    assert.throws(() => parseListFilters({ limit: '101' }, now));
    assert.throws(() => parseListFilters({ status: 'LOST' }, now));
    assert.throws(() => parseListFilters({ step: 'phone_number' }, now));
    assert.throws(() => parseListFilters({ id: 'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz' }, now));
    assert.equal(parseListFilters({ limit: '50', status: 'ACTIVE', step: 'phone' }, now).limit, 50);
  });

  it('round-trips deterministic opaque cursors and rejects tampering', () => {
    const cursor = encodeCursor('2026-03-08T10:00:00.000Z', '43c6b8b9-e65f-44bc-9ba6-f015b2897832');
    assert.deepEqual(decodeCursor(cursor), ['2026-03-08T10:00:00.000Z', '43c6b8b9-e65f-44bc-9ba6-f015b2897832']);
    assert.throws(() => decodeCursor('not-a-cursor'));
  });
});
