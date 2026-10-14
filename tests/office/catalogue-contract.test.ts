import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateQuoteCatalog } from '../../src/office/backend/event-quote-workflow';
import { testCatalog, testScope, TEST_AT } from './event-quote-fixtures';

const schema = JSON.parse(readFileSync(new URL('../../docs/catalogue-authority.schema.json', import.meta.url), 'utf8'));
test('catalogue handoff schema enumerates exact fields and has no invented prices/default rules', () => {
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.slice().sort(), Object.keys(testCatalog).sort());
  assert.equal(schema.properties.authority.const, 'owner_authorized'); assert.equal(schema.properties.currency.const, 'USD');
  assert.equal(schema.properties.items.minItems, 1); assert.equal(schema.properties.items.maxItems, 100);
  assert.equal(schema.properties.items.items.additionalProperties, false);
  assert.deepEqual(schema.properties.items.items.required.slice().sort(), Object.keys(testCatalog.items[0]).sort());
  assert.equal(schema.properties.items.items.properties.unitPriceCents.maximum, 1000000);
  for (const field of ['taxBps', 'depositBps']) assert.deepEqual([schema.properties[field].minimum, schema.properties[field].maximum], [0, 10000]);
  assert.doesNotMatch(JSON.stringify(schema), /"(?:default|examples)":/);
});
test('commercial runtime enforces schema scope, required values and dynamic expiry/uniqueness beyond JSON shape', () => {
  const owner = { ...testScope, mode: 'commercial' as const };
  const c = { ...testCatalog, authority: 'owner_authorized' as const };
  assert.deepEqual(validateQuoteCatalog(c, owner, TEST_AT), c);
  for (const key of schema.required) { const missing = { ...c } as Record<string, unknown>; delete missing[key]; assert.throws(() => validateQuoteCatalog(missing, owner, TEST_AT)); }
  for (const invalid of [{ ...c, unexpected: true }, { ...c, currency: 'PEN' }, { ...c, authority: 'test_only' }, { ...c, validUntilMs: TEST_AT }, { ...c, items: [c.items[0], { ...c.items[0], label: 'Another label, same ID' }] }, { ...c, taxBps: 10001 }, { ...c, depositBps: -1 }, { ...c, items: [{ ...c.items[0], unitPriceCents: 1000001 }] }]) assert.throws(() => validateQuoteCatalog(invalid, owner, TEST_AT));
});
