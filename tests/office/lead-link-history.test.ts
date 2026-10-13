import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHistoricalLink as normalize, historicalLeadKey, summarizeHistoricalLink, historicalParameterDifferences, historicalSessionConsistency, LEAD_LINK_COLUMNS } from '../../src/office/backend/lead-link-history.ts';
const provenance = { accountId: 'synthetic-account', boardId: '200', itemId: '300', columnId: 'text_mm1kdqqb', updateId: null, observedAt: '2026-10-13T20:00:00Z', changedAt: null, originalValueType: 'text' };
const make = (originalUrl: string | null) => normalize({ provenance, originalUrl });
const url = 'https://example.invalid/calculator?itemId=300&boardId=200&sessionId=external-one&guests=50&utm_campaign=synthetic&name=Test%20Person';
test('preserves exact signed encoding, duplicate query entries, attribution and nested layer once', () => {
  const nested = 'https://landing.invalid/?utm_source=search&utm_campaign=a&utm_campaign=b&gclid=synthetic-click&sourceUrl=https%3A%2F%2Fdeep.invalid%2F';
  const raw = url + '&signature=%2f%2B&sourceUrl=' + encodeURIComponent(nested);
  const l = make(raw);
  assert.equal(l.status, 'historical'); assert.equal(l.outer?.originalUrl, raw);
  assert.equal(l.source?.originalUrl, nested);
  assert.deepEqual(l.source?.campaignParameters.slice(1, 3), [['utm_campaign','a'],['utm_campaign','b']]);
  assert.equal(l.source?.parameters.at(-1)?.[1], 'https://deep.invalid/');
  assert.equal(l.externalSessionId, 'external-one'); assert.equal(l.humanVisitEvidence, false);
  assert.ok(Object.isFrozen(l.outer?.parameters[0]));
});
test('does not rewrite canonical state; differences are neutral historical observations', () => {
  const current = Object.freeze({ guests: '45', menu: 'agreed menu', amount: '900' });
  assert.deepEqual(historicalParameterDifferences(make(url), current), [{ parameter: 'guests', initialValue: '50', currentValue: '45', relationship: 'historical_difference' }]);
  assert.equal(current.guests, '45');
});
test('preserves source account, item, column/update and unknown change time', () => {
  const l = normalize({ provenance: { ...provenance, columnId: null, updateId: '444', originalValueType: 'update-body' }, originalUrl: 'https://files.invalid/quote.pdf' });
  assert.equal(l.category, 'update_link'); assert.deepEqual(l.provenance, { ...provenance, columnId: null, updateId: '444', originalValueType: 'update-body' });
  assert.notEqual(historicalLeadKey(provenance), historicalLeadKey({ ...provenance, accountId: 'other-account' }));
  assert.notEqual(historicalLeadKey(provenance), historicalLeadKey({ ...provenance, boardId: '201' }));
});
test('missing URLs stay missing; no inferred calculator/AI links', () => {
  for (const v of [null, '']) { const l = make(v); assert.equal(l.status, 'missing'); assert.equal(l.outer, null); }
});
test('all six real column mappings are represented but keyword is never treated as a URL', () => {
  assert.equal(Object.keys(LEAD_LINK_COLUMNS).length, 6);
  assert.throws(() => normalize({ provenance: { ...provenance, columnId: 'text_mm1epjsq' }, originalUrl: 'catering' }), /Invalid historical link input/);
});
test('mismatched and duplicated identity is quarantined rather than joined by name', () => {
  for (const suffix of ['&itemId=other', '&boardId=other', '&itemId=300', '&sessionId=other', '&sessionId=']) {
    const l = make(url + suffix); assert.equal(l.status, 'quarantined'); assert.equal(l.externalSessionId, null);
    assert.deepEqual(historicalParameterDifferences(l, { guests: '45' }), []);
  }
});
test('nested identity/session is validated without following nested destinations', () => {
  const l = make(url + '&sourceUrl=' + encodeURIComponent('https://example.invalid/?itemId=999&sessionId=other'));
  assert.deepEqual(l.issues, ['item_mismatch', 'session_mismatch']);
});
test('rejects XSS and credential-bearing targets; errors never expose raw inputs', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///etc/passwd', '//example.invalid', 'https://user:secret@example.invalid', 'https://example.invalid/\nx', 'https:\\example.invalid', 'https:// example.invalid', 'https:///example.invalid']) {
    assert.throws(() => make(bad), { message: 'Invalid historical link input' });
  }
});
test('bad nested URLs and ambiguous sourceUrl are retained only in quarantine', () => {
  for (const suffix of ['&sourceUrl=javascript%3Aalert(1)', '&sourceUrl=https%253A%252F%252Fexample.invalid', '&sourceUrl=https%3A%2F%2Fa.invalid&sourceUrl=https%3A%2F%2Fb.invalid']) assert.equal(make(url + suffix).status, 'quarantined');
});
test('operational summary exposes no PII, query, path, campaign value or session', () => {
  const summary = JSON.stringify(summarizeHistoricalLink(make(url)));
  for (const secret of ['Test', 'Person', 'example.invalid', 'external-one', 'guests', 'synthetic']) assert.ok(!summary.includes(secret));
});
test('no fetch side effect even for internal HTTP targets; syntax does not authorize networking', () => {
  const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = (() => { calls++; throw new Error('network forbidden'); }) as typeof fetch;
  try { make('http://127.0.0.1/private'); make('http://169.254.169.254/latest/meta-data'); make(url); assert.equal(calls, 0); } finally { globalThis.fetch = saved; }
});
test('timestamps, source provenance, bounded input, unknown properties and accessors fail closed', () => {
  for (const p of [{...provenance, observedAt:'2026-02-30T20:00:00Z'}, {...provenance, updateId:'1'}, {...provenance, columnId:null}, {...provenance, accountId:''}]) assert.throws(() => normalize({provenance:p,originalUrl:url}));
  assert.throws(() => make('https://example.invalid/?x=' + 'a'.repeat(32768)));
  assert.throws(() => normalize({ provenance, originalUrl:url, unexpected: true } as never));
  let called = false;
  assert.throws(() => normalize({ provenance, get originalUrl() { called = true; return url; } }));
  assert.equal(called, false);
});
test('session comparison requires exact scoped lead and does not pick a winner', () => {
  assert.equal(historicalSessionConsistency([make(url), make(url)]), 'consistent');
  assert.equal(historicalSessionConsistency([make(url), make(url.replace('external-one','external-two'))]), 'different');
  assert.equal(historicalSessionConsistency([make(null)]), 'unknown');
  assert.throws(() => historicalSessionConsistency([make(url), normalize({provenance: {...provenance,accountId:'other'},originalUrl:url})]));
});
