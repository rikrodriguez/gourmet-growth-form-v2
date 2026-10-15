import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectConfirmationClarity } from '../../src/measurement/confirmation-clarity';
import type { ConsentState, PersistedConsent } from '../../src/measurement/contracts';

type Dependencies = Required<NonNullable<Parameters<typeof connectConfirmationClarity>[0]>>;
type Listener = Parameters<Dependencies['consent']['subscribe']>[0];
type VendorCall = { method: 'load' | 'update'; state: ConsentState };

const DENIED: ConsentState = Object.freeze({
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
});

function preference(overrides: Partial<ConsentState> = {}): PersistedConsent {
  return Object.freeze({
    ...DENIED,
    ...overrides,
    version: 1,
    updated_at: '2026-10-15T12:00:00.000Z',
  });
}

function createHarness(initialPreference: PersistedConsent | null = null) {
  let currentPreference = initialPreference;
  let effectiveState: ConsentState = DENIED;
  let initialized = false;
  const listeners = new Set<Listener>();
  const order: string[] = [];
  const calls: VendorCall[] = [];

  const dependencies: Dependencies = {
    prepareUrl() {
      order.push('prepareUrl');
      return true;
    },
    consent: {
      initialize() {
        order.push('initialize');
        initialized = true;
        effectiveState = currentPreference ?? DENIED;
        return currentPreference;
      },
      getEffectiveState() {
        assert.equal(initialized, true, 'initialize must run before reading effective consent');
        order.push('getEffectiveState');
        return effectiveState;
      },
      subscribe(listener) {
        assert.equal(initialized, true, 'initialize must run before subscribing');
        order.push('subscribe');
        listeners.add(listener);
        return () => {
          order.push('unsubscribe');
          listeners.delete(listener);
        };
      },
    },
    load(state) {
      order.push('load');
      calls.push({ method: 'load', state });
      return true;
    },
    update(state) {
      order.push('update');
      calls.push({ method: 'update', state });
    },
  };

  return {
    dependencies,
    calls,
    order,
    listeners,
    publish(next: PersistedConsent | null) {
      currentPreference = next;
      effectiveState = next ?? DENIED;
      listeners.forEach((listener) => listener(next));
    },
  };
}

describe('confirmation-only Clarity consent lifecycle', () => {
  it('initializes stored consent before reading or applying the effective state', () => {
    const stored = preference({ analytics_storage: 'granted' });
    const harness = createHarness(stored);

    const cleanup = connectConfirmationClarity(harness.dependencies);

    assert.deepEqual(harness.order, ['prepareUrl', 'initialize', 'subscribe', 'getEffectiveState', 'load']);
    assert.deepEqual(harness.calls, [{ method: 'load', state: stored }]);
    assert.equal(harness.listeners.size, 1);
    cleanup();
  });

  it('does not initialize, subscribe, or invoke vendors when URL preparation fails', () => {
    const harness = createHarness(preference({ analytics_storage: 'granted' }));
    harness.dependencies.prepareUrl = () => {
      harness.order.push('prepareUrl');
      return false;
    };

    const cleanup = connectConfirmationClarity(harness.dependencies);

    assert.deepEqual(harness.order, ['prepareUrl']);
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.listeners.size, 0);
    assert.doesNotThrow(cleanup);
    harness.publish(preference({ analytics_storage: 'granted' }));
    assert.deepEqual(harness.order, ['prepareUrl']);
    assert.deepEqual(harness.calls, []);
  });

  it('applies effective denial without loading Clarity when there is no preference', () => {
    const harness = createHarness();

    const cleanup = connectConfirmationClarity(harness.dependencies);

    assert.deepEqual(harness.calls, [{ method: 'update', state: DENIED }]);
    assert.equal(harness.calls[0].state, DENIED);
    cleanup();
  });

  it('preserves an explicit rejection and never loads Clarity', () => {
    const rejected = preference();
    const harness = createHarness(rejected);

    const cleanup = connectConfirmationClarity(harness.dependencies);

    assert.deepEqual(harness.calls, [{ method: 'update', state: rejected }]);
    assert.equal(harness.calls[0].state, rejected);
    cleanup();
  });

  it('loads Clarity for analytics-only consent without granting advertising fields', () => {
    const analyticsOnly = preference({ analytics_storage: 'granted' });
    const harness = createHarness(analyticsOnly);

    const cleanup = connectConfirmationClarity(harness.dependencies);

    assert.deepEqual(harness.calls, [{ method: 'load', state: analyticsOnly }]);
    assert.equal(harness.calls[0].state, analyticsOnly);
    assert.equal(harness.calls[0].state.ad_storage, 'denied');
    assert.equal(harness.calls[0].state.ad_user_data, 'denied');
    assert.equal(harness.calls[0].state.ad_personalization, 'denied');
    cleanup();
  });

  it('does not load Clarity for advertising-only consent', () => {
    const advertisingOnly = preference({
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    });
    const harness = createHarness(advertisingOnly);

    const cleanup = connectConfirmationClarity(harness.dependencies);

    assert.deepEqual(harness.calls, [{ method: 'update', state: advertisingOnly }]);
    assert.equal(harness.calls[0].state, advertisingOnly);
    cleanup();
  });

  it('loads Clarity when all consent categories are granted', () => {
    const allGranted = preference({
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'granted',
      ad_personalization: 'granted',
    });
    const harness = createHarness(allGranted);

    const cleanup = connectConfirmationClarity(harness.dependencies);

    assert.deepEqual(harness.calls, [{ method: 'load', state: allGranted }]);
    cleanup();
  });

  it('applies grant, revoke, and regrant in order from the latest effective state', () => {
    const harness = createHarness();
    const accepted = preference({ analytics_storage: 'granted' });
    const revoked = preference();
    const reaccepted = preference({ analytics_storage: 'granted', ad_storage: 'granted' });
    const cleanup = connectConfirmationClarity(harness.dependencies);

    harness.publish(accepted);
    harness.publish(revoked);
    harness.publish(reaccepted);

    assert.deepEqual(harness.calls, [
      { method: 'update', state: DENIED },
      { method: 'load', state: accepted },
      { method: 'update', state: revoked },
      { method: 'load', state: reaccepted },
    ]);
    assert.equal(harness.order.filter((entry) => entry === 'getEffectiveState').length, 4);
    assert.equal(harness.listeners.size, 1);
    cleanup();
  });

  it('passes the complete state unchanged for updates while analytics remains granted', () => {
    const first = preference({ analytics_storage: 'granted' });
    const next = preference({
      analytics_storage: 'granted',
      ad_storage: 'granted',
      ad_user_data: 'denied',
      ad_personalization: 'granted',
    });
    const harness = createHarness(first);
    const cleanup = connectConfirmationClarity(harness.dependencies);

    harness.publish(next);

    assert.deepEqual(harness.calls, [
      { method: 'load', state: first },
      { method: 'load', state: next },
    ]);
    assert.equal(harness.calls[1].state, next);
    assert.deepEqual(Object.keys(harness.calls[1].state).sort(), Object.keys(next).sort());
    cleanup();
  });

  it('returns to effective denial when an updated preference is absent', () => {
    const accepted = preference({ analytics_storage: 'granted' });
    const harness = createHarness(accepted);
    const cleanup = connectConfirmationClarity(harness.dependencies);

    harness.publish(null);

    assert.deepEqual(harness.calls, [
      { method: 'load', state: accepted },
      { method: 'update', state: DENIED },
    ]);
    cleanup();
  });

  it('only unsubscribes during cleanup and has no consent effects after cleanup', () => {
    const accepted = preference({ analytics_storage: 'granted' });
    const harness = createHarness(accepted);
    const cleanup = connectConfirmationClarity(harness.dependencies);

    cleanup();

    assert.equal(harness.listeners.size, 0);
    assert.deepEqual(harness.calls, [{ method: 'load', state: accepted }]);
    const orderAfterCleanup = [...harness.order];
    harness.publish(preference());
    harness.publish(accepted);
    harness.publish(null);
    assert.deepEqual(harness.calls, [{ method: 'load', state: accepted }]);
    assert.deepEqual(harness.order, orderAfterCleanup);
  });

  it('keeps one active listener after a StrictMode-style cleanup and remount', () => {
    const accepted = preference({ analytics_storage: 'granted' });
    const rejected = preference();
    const harness = createHarness(accepted);
    const cleanupFirstMount = connectConfirmationClarity(harness.dependencies);

    cleanupFirstMount();
    const cleanupSecondMount = connectConfirmationClarity(harness.dependencies);

    assert.equal(harness.listeners.size, 1);
    // Vendor loading is idempotent; each mount may apply consent, but cleanup
    // must not insert a revocation between them.
    assert.deepEqual(harness.calls, [
      { method: 'load', state: accepted },
      { method: 'load', state: accepted },
    ]);
    harness.publish(rejected);
    assert.deepEqual(harness.calls, [
      { method: 'load', state: accepted },
      { method: 'load', state: accepted },
      { method: 'update', state: rejected },
    ]);
    cleanupSecondMount();
    assert.equal(harness.listeners.size, 0);
    const callsAfterCleanup = [...harness.calls];
    harness.publish(accepted);
    assert.deepEqual(harness.calls, callsAfterCleanup);
  });

  it('does not detach the remounted listener if an old cleanup is called again', () => {
    const harness = createHarness();
    const cleanupFirstMount = connectConfirmationClarity(harness.dependencies);
    cleanupFirstMount();
    const cleanupSecondMount = connectConfirmationClarity(harness.dependencies);

    cleanupFirstMount();

    assert.equal(harness.listeners.size, 1);
    const accepted = preference({ analytics_storage: 'granted' });
    harness.publish(accepted);
    assert.deepEqual(harness.calls, [
      { method: 'update', state: DENIED },
      { method: 'update', state: DENIED },
      { method: 'load', state: accepted },
    ]);
    cleanupSecondMount();
    assert.equal(harness.listeners.size, 0);
  });
});
