import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveCustomerExperimentsEnabled } from '../../src/measurement/config';

describe('production measurement configuration', () => {
  it('defaults customer experiments to off and rejects production opt-in', () => {
    assert.equal(resolveCustomerExperimentsEnabled('staging', undefined), false);
    assert.equal(resolveCustomerExperimentsEnabled('production', undefined), false);
    assert.equal(resolveCustomerExperimentsEnabled('production', 'true'), false);
  });

  it('permits an explicit non-production QA opt-in only', () => {
    assert.equal(resolveCustomerExperimentsEnabled('staging', 'true'), true);
    assert.equal(resolveCustomerExperimentsEnabled('staging', 'false'), false);
  });
});
