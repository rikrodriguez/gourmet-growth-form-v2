import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMonday } from '../../src/context/monday-comparison.mjs';

const values = () => ({
  customerName: 'Cliente ficticio', eventDate: '2026-12-15', reservationSummary: 'Cena ficticia',
  currency: 'USD', agreedTotal: '1000.00', depositAmount: '250.00',
});
const snapshot = fields => ({
  source: 'monday', fetchedAt: '2026-10-28T02:00:00.000Z', itemId: 'fixture-item-1',
  identityConfirmed: true, fields: fields ?? values(),
});

test('without a snapshot reports unavailable for every field without fabricating values', () => {
  const result = compareMonday({ customerName: 'Cliente ficticio' });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.provenance, null);
  assert.equal(result.fields.customerName.voiceValue, 'Cliente ficticio');
  assert.equal(result.fields.customerName.mondayValue, null);
  assert.equal(result.fields.depositAmount.voiceValue, null);
  assert.ok(Object.values(result.fields).every(field => field.status === 'unavailable'));
  assert.match(result.warnings[0], /no se verificó/);
});

test('compares exact confirmed values and retains snapshot provenance without claiming live verification', () => {
  const result = compareMonday(values(), snapshot());
  assert.equal(result.status, 'match');
  assert.ok(Object.values(result.fields).every(field => field.status === 'match'));
  assert.equal(result.provenance.fetchedAt, '2026-10-28T02:00:00.000Z');
  assert.equal(result.provenance.itemId, 'fixture-item-1');
  assert.ok(result.warnings.some(warning => warning.includes('no demuestra frescura')));
});

test('conflicting amounts or dates retain both sources and never prefer Monday or the newest snapshot', () => {
  const voice = values();
  const monday = snapshot({ ...values(), eventDate: '2026-12-16', agreedTotal: '1200.00' });
  const voiceBefore = structuredClone(voice);
  const mondayBefore = structuredClone(monday);
  const result = compareMonday(voice, monday);
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.fields.agreedTotal, { status: 'conflict', voiceValue: '1000.00', mondayValue: '1200.00' });
  assert.equal(result.fields.eventDate.status, 'conflict');
  assert.deepEqual(voice, voiceBefore);
  assert.deepEqual(monday, mondayBefore);
});

test('partial snapshots report missing values and conflicts take precedence over incompleteness', () => {
  const partial = compareMonday(values(), snapshot({ customerName: 'Cliente ficticio' }));
  assert.equal(partial.status, 'incomplete');
  assert.deepEqual(partial.fields.depositAmount, { status: 'missing', voiceValue: '250.00', mondayValue: null });
  assert.equal(compareMonday({ customerName: 'Otro cliente ficticio' }, snapshot({ customerName: 'Cliente ficticio' })).status, 'conflict');
  assert.equal(compareMonday({}, snapshot()).fields.customerName.status, 'missing');
});

test('rejects unidentified snapshots, malformed metadata and unsupported fields', () => {
  for (const identityConfirmed of [false, 'true', undefined]) {
    assert.throws(() => compareMonday(values(), { ...snapshot(), identityConfirmed }), /identidad/);
  }
  for (const changes of [
    { source: 'voice' }, { fetchedAt: '2026-02-30T12:00:00Z' }, { fetchedAt: 'yesterday' },
    { fetchedAt: '2026-10-28T24:00:00Z' }, { itemId: '' }, { itemId: 123 }, { fields: [] },
    { fields: { phone: 'fixture' } }, { secret: 'fixture' },
  ]) assert.throws(() => compareMonday(values(), { ...snapshot(), ...changes }));
  assert.throws(() => compareMonday({ ...values(), paypalUrl: 'https://example.invalid' }, snapshot()), /desconocido/);
});

test('requires explicit canonical money, currency and real dates without rounding or conversion', () => {
  for (const fields of [
    { depositAmount: '250' }, { depositAmount: '$250.00' }, { depositAmount: 250 },
    { depositAmount: '-1.00' }, { depositAmount: '0.00' }, { depositAmount: '250.001' },
    { currency: 'EUR' }, { eventDate: '2026-02-29' }, { customerName: ' Cliente ' },
    { agreedTotal: '100.00', depositAmount: '101.00' },
  ]) {
    assert.throws(() => compareMonday(fields));
    assert.throws(() => compareMonday(values(), snapshot(fields)));
  }
  assert.equal(compareMonday({ eventDate: '2028-02-29' }, snapshot({ eventDate: '2028-02-29' })).fields.eventDate.status, 'match');
});
