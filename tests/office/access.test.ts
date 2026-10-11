import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canWriteFor } from '../../src/office/access';
import type { DemoSession } from '../../src/office/adapter';
import type { OfficeCommand } from '../../src/office/contracts';

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
const session: DemoSession = {
  mode: 'demo', actorId: 'OFFICE_DEMO_OPERATOR', role: 'operator',
  caseIds: ['demo-cedar'], functionIds: ['finance'],
  expiresAt: new Date(NOW + 60_000).toISOString(),
  storage: { kind: 'postgres', durable: true }, outboundEffects: 0,
};
const approvedTarget = { caseId: 'demo-cedar', functionId: 'finance' } as const;

describe('office write permissions for the action target', () => {
  it('uses the approval case and function independently of the workspace selection', () => {
    const otherWorkspace = { caseId: 'demo-aurora', functionId: 'sales' } as const;
    assert.equal(canWriteFor(session, otherWorkspace, NOW, null), false);
    assert.equal(canWriteFor(session, approvedTarget, NOW, null), true);

    // Selecting an allowed workspace must not enable a different drawer row.
    assert.equal(canWriteFor(session, { ...approvedTarget, caseId: 'demo-aurora' }, NOW, null), false);
    assert.equal(canWriteFor(session, { ...approvedTarget, functionId: 'sales' }, NOW, null), false);
    assert.equal(canWriteFor(session, { ...approvedTarget, caseId: 'demo-cedar-other' }, NOW, null), false);
  });

  it('requires a server operator session and a concrete target', () => {
    assert.equal(canWriteFor(null, approvedTarget, NOW, null), false);
    assert.equal(canWriteFor(session, null, NOW, null), false);
    assert.equal(canWriteFor({ ...session, role: 'viewer' }, approvedTarget, NOW, null), false);
  });

  it('denies decisions at expiry or with an invalid clock or expiration', () => {
    assert.equal(canWriteFor({ ...session, expiresAt: new Date(NOW + 1).toISOString() }, approvedTarget, NOW, null), true);
    for (const expiresAt of [new Date(NOW).toISOString(), new Date(NOW - 1).toISOString(), 'invalid']) {
      assert.equal(canWriteFor({ ...session, expiresAt }, approvedTarget, NOW, null), false);
    }
    for (const nowMs of [NaN, Infinity, -Infinity]) assert.equal(canWriteFor(session, approvedTarget, nowMs, null), false);
  });

  it('blocks every new action while any unconfirmed command is pending', () => {
    const pending: OfficeCommand = {
      idempotencyKey: 'unconfirmed-command', caseId: 'demo-aurora',
      functionId: 'sales', action: 'chat', text: 'Consulta sintética sin confirmar.',
    };
    assert.equal(canWriteFor(session, approvedTarget, NOW, pending), false);
    assert.equal(canWriteFor(session, approvedTarget, NOW, { ...pending, ...approvedTarget }), false);
    assert.equal(canWriteFor(session, approvedTarget, NOW, null), true);
  });
});
