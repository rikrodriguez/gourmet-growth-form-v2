import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposeRetainerBalanceDateV2, resolveApprovedLocalMinuteV2 } from '../../src/office/backend/payment-calendar-v2';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const input = (patch: Partial<Parameters<typeof proposeRetainerBalanceDateV2>[0]> = {}) => ({
  eventDate: '2027-03-15', eventTime: '12:00', timezone: 'America/New_York', nowMs: NOW, ...patch,
});

test('retainer proposes seven local calendar days before the event without proposing a balance hour', () => {
  const source = input(), before = structuredClone(source);
  assert.deepEqual(proposeRetainerBalanceDateV2(source), {
    proposedBalanceDate: '2027-03-08', requiresExplicitReview: false, codes: [],
  });
  assert.deepEqual(source, before);
});

for (const fixture of [
  { date: '2027-03-15', proposed: '2027-03-08', utcEvent: '2027-03-15T16:00:00Z', utcBalance: '2027-03-08T17:00:00Z', hours: 167 },
  { date: '2026-11-07', proposed: '2026-10-31', utcEvent: '2026-11-07T17:00:00Z', utcBalance: '2026-10-31T16:00:00Z', hours: 169 },
]) {
  test(`New York calendar subtraction crosses DST in ${fixture.hours} elapsed hours`, () => {
    const proposal = proposeRetainerBalanceDateV2(input({ eventDate: fixture.date }));
    assert.equal(proposal.proposedBalanceDate, fixture.proposed);
    // The noon below is an independently supplied, approved time, not a time
    // inferred by the date-only proposal.
    const event = resolveApprovedLocalMinuteV2(fixture.date, '12:00', 'America/New_York');
    const balance = resolveApprovedLocalMinuteV2(fixture.proposed, '12:00', 'America/New_York');
    assert.equal(event, fixture.utcEvent); assert.equal(balance, fixture.utcBalance);
    assert.equal((Date.parse(event!) - Date.parse(balance!)) / 3_600_000, fixture.hours);
  });
}

for (const [eventDate, proposedBalanceDate] of [
  ['2028-03-03', '2028-02-25'], ['2028-02-29', '2028-02-22'],
  ['2027-03-03', '2027-02-24'], ['2099-01-03', '2098-12-27'],
]) {
  test(`calendar subtraction preserves leap/month/year boundaries: ${eventDate}`, () => {
    assert.deepEqual(proposeRetainerBalanceDateV2(input({ eventDate, timezone: 'UTC' })), {
      proposedBalanceDate, requiresExplicitReview: false, codes: [],
    });
  });
}

test('Kathmandu fractional timezone preserves the approved minute and calendar proposal', () => {
  assert.equal(resolveApprovedLocalMinuteV2('2027-07-01', '18:00', 'Asia/Kathmandu'), '2027-07-01T12:15:00Z');
  assert.equal(proposeRetainerBalanceDateV2(input({ eventDate: '2027-07-01', eventTime: '18:00', timezone: 'Asia/Kathmandu' })).proposedBalanceDate, '2027-06-24');
});

test('missing event time retains only a date proposal and requires explicit review', () => {
  assert.deepEqual(proposeRetainerBalanceDateV2(input({ eventTime: null })), {
    proposedBalanceDate: '2027-03-08', requiresExplicitReview: true, codes: ['EVENT_TIME_REQUIRED'],
  });
});

for (const [patch, code] of [
  [{ eventDate: null }, 'EVENT_DATE_REQUIRED'],
  [{ eventDate: '2027-02-29' }, 'INVALID_EVENT_DATE'],
  [{ timezone: null }, 'TIMEZONE_REQUIRED'],
  [{ timezone: 'Mars/Olympus' }, 'INVALID_TIMEZONE'],
  [{ nowMs: Number.NaN }, 'INVALID_NOW'],
  [{ nowMs: Number.POSITIVE_INFINITY }, 'INVALID_NOW'],
  [{ nowMs: 8_640_000_000_000_001 }, 'INVALID_NOW'],
] as const) {
  test(`missing or invalid calendar authority blocks the proposal: ${code} ${JSON.stringify(patch)}`, () => {
    const proposal = proposeRetainerBalanceDateV2(input(patch));
    assert.equal(proposal.proposedBalanceDate, null);
    assert.equal(proposal.requiresExplicitReview, true);
    assert.ok(proposal.codes.includes(code));
  });
}

test('a date proposed before the supported calendar year is not normalized to year zero', () => {
  const proposal = proposeRetainerBalanceDateV2(input({ eventDate: '0001-01-03', timezone: 'UTC' }));
  assert.equal(proposal.proposedBalanceDate, null); assert.equal(proposal.requiresExplicitReview, true);
  assert.ok(proposal.codes.includes('BALANCE_DATE_OUT_OF_RANGE'));
});

for (const time of ['12:00:01', '12:00:00', '12:00.001', '24:00', '1:00', ' 12:00']) {
  test(`invalid or over-precise event time remains pending: ${JSON.stringify(time)}`, () => {
    const proposal = proposeRetainerBalanceDateV2(input({ eventTime: time }));
    assert.equal(proposal.proposedBalanceDate, '2027-03-08'); assert.equal(proposal.requiresExplicitReview, true);
    assert.deepEqual(proposal.codes, ['INVALID_EVENT_TIME']);
    assert.equal(resolveApprovedLocalMinuteV2('2027-03-15', time, 'America/New_York'), null);
  });
}

for (const [eventDate, proposedBalanceDate, expected] of [
  ['2027-06-28', '2027-06-21', ['EVENT_WITHIN_SEVEN_DAYS', 'PROPOSED_BALANCE_DATE_PAST']],
  ['2027-06-25', '2027-06-18', ['EVENT_DATE_NOT_FUTURE', 'PROPOSED_BALANCE_DATE_PAST']],
  ['2027-06-24', '2027-06-17', ['EVENT_DATE_NOT_FUTURE', 'PROPOSED_BALANCE_DATE_PAST']],
  ['2027-07-02', '2027-06-25', ['PROPOSED_BALANCE_DATE_TODAY']],
] as const) {
  test(`near/today/past event ${eventDate} requires review without moving the seven-day date`, () => {
    const proposal = proposeRetainerBalanceDateV2(input({ eventDate, nowMs: Date.parse('2027-06-25T12:00:00Z'), timezone: 'UTC' }));
    assert.equal(proposal.proposedBalanceDate, proposedBalanceDate);
    assert.equal(proposal.requiresExplicitReview, true); assert.deepEqual(proposal.codes, expected);
  });
}

test('review windows use the supplied timezone date rather than the UTC date', () => {
  const kathmandu = proposeRetainerBalanceDateV2(input({ eventDate: '2027-07-01', timezone: 'Asia/Kathmandu', nowMs: Date.parse('2027-06-24T23:00:00Z') }));
  assert.equal(kathmandu.proposedBalanceDate, '2027-06-24');
  assert.deepEqual(kathmandu.codes, ['EVENT_WITHIN_SEVEN_DAYS', 'PROPOSED_BALANCE_DATE_PAST']);
  const newYork = proposeRetainerBalanceDateV2(input({ eventDate: '2027-07-01', nowMs: Date.parse('2027-06-25T02:00:00Z') }));
  assert.equal(newYork.proposedBalanceDate, '2027-06-24');
  assert.deepEqual(newYork.codes, ['PROPOSED_BALANCE_DATE_TODAY']);
});

for (const [date, time, timezone] of [
  ['2026-11-01', '01:30', 'America/New_York'],
  ['2027-03-14', '02:30', 'America/New_York'],
  ['2027-04-04', '01:45', 'Australia/Lord_Howe'],
  ['2027-10-03', '02:15', 'Australia/Lord_Howe'],
  ['2011-12-30', '12:00', 'Pacific/Apia'],
]) {
  test(`approved local minute rejects a timezone gap/fold: ${timezone} ${date} ${time}`, () => {
    assert.equal(resolveApprovedLocalMinuteV2(date, time, timezone), null);
    const proposal = proposeRetainerBalanceDateV2(input({ eventDate: date, eventTime: time, timezone }));
    assert.equal(proposal.requiresExplicitReview, true);
    assert.ok(proposal.codes.includes('EVENT_LOCAL_MINUTE_UNRESOLVED'));
  });
}

for (const timezone of ['CST', 'PST', 'EST', 'GMT', '+05:45', 'Mars/Olympus', ' UTC']) {
  test(`unknown timezone, abbreviation or offset is not guessed: ${timezone}`, () => {
    assert.equal(resolveApprovedLocalMinuteV2('2027-07-01', '18:00', timezone), null);
    assert.deepEqual(proposeRetainerBalanceDateV2(input({ timezone })), {
      proposedBalanceDate: null, requiresExplicitReview: true, codes: ['INVALID_TIMEZONE'],
    });
  });
}

for (const date of ['2027-02-29', '2028-04-31', '2027-1-01', '0000-01-01', '2027-01-01T12:00', ' 2027-01-01']) {
  test(`approved local minute rejects invalid date ${JSON.stringify(date)}`, () => {
    assert.equal(resolveApprovedLocalMinuteV2(date, '12:00', 'UTC'), null);
  });
}

test('explicit UTC, midnight and four-digit years retain their actual calendar', () => {
  assert.equal(resolveApprovedLocalMinuteV2('2028-02-29', '00:00', 'UTC'), '2028-02-29T00:00:00Z');
  assert.equal(resolveApprovedLocalMinuteV2('0001-01-01', '00:00', 'UTC'), '0001-01-01T00:00:00Z');
  assert.equal(resolveApprovedLocalMinuteV2('0099-01-01', '00:00', 'UTC'), '0099-01-01T00:00:00Z');
});

test('historical timezone seconds are preserved instead of accepting the wrong wall minute', () => {
  assert.equal(resolveApprovedLocalMinuteV2('1900-01-01', '12:00', 'Asia/Kathmandu'), '1900-01-01T06:18:44Z');
});
