import assert from 'node:assert/strict';
import { describe, it, type TestContext } from 'node:test';
import { connectConfirmationClarity, prepareConfirmationUrl } from '../../src/measurement/confirmation-clarity';
import { measurementConfig } from '../../src/measurement/config';
import { consentManager } from '../../src/measurement/consent';
import type { PersistedConsent } from '../../src/measurement/contracts';

const CONSENT_KEY = 'gourmet_growth_measurement_consent_v1';
const PENDING_KEY = 'gourmet_growth_measurement_pending_v1';
const MILESTONES_KEY = 'gourmet_growth_measurement_milestones_v1';
const FreshConsentManager = consentManager.constructor as new () => typeof consentManager;

class FakeStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly operations: string[] = [];
  failReads = false;
  failWrites = false;

  get length() { return this.values.size; }
  clear() { this.operations.push('clear'); this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) {
    this.operations.push(`get:${key}`);
    if (this.failReads) throw new Error('Storage access denied');
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.operations.push(`set:${key}`);
    if (this.failWrites) throw new Error('Storage access denied');
    this.values.set(key, value);
  }
  removeItem(key: string) { this.operations.push(`remove:${key}`); this.values.delete(key); }
}

type FakeScript = { id: string; src: string; async: boolean };
type Navigation = NonNullable<Parameters<typeof prepareConfirmationUrl>[0]>;

function savedConsent(analytics = false, ads = false): PersistedConsent {
  return {
    version: 1,
    updated_at: '2026-10-15T12:00:00.000Z',
    analytics_storage: analytics ? 'granted' : 'denied',
    ad_storage: ads ? 'granted' : 'denied',
    ad_user_data: ads ? 'granted' : 'denied',
    ad_personalization: ads ? 'granted' : 'denied',
  };
}

function replaceProperty(t: TestContext, target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  t.after(() => {
    if (original) Object.defineProperty(target, key, original);
    else Reflect.deleteProperty(target, key);
  });
}

function setup(t: TestContext, rawConsent: string | null = null, path = '/form2/request-received/', referrer = '') {
  const localStorage = new FakeStorage();
  const sessionStorage = new FakeStorage();
  if (rawConsent !== null) localStorage.values.set(CONSENT_KEY, rawConsent);
  const scripts: FakeScript[] = [];
  const url = new URL(path, 'https://qa.example');
  const location: Navigation['location'] = { pathname: url.pathname, search: url.search, hash: url.hash };
  const history: { state: unknown; replaceState: Navigation['history']['replaceState'] } = {
    state: { synthetic: true },
    replaceState(state, _unused, nextUrl) {
      const next = new URL(String(nextUrl), 'https://qa.example');
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
      this.state = state;
    },
  };
  // This DOM records script creation only. It never executes scripts or sends
  // requests, so the production vendor functions remain safe to exercise.
  const fakeDocument = {
    referrer,
    getElementById(id: string) { return scripts.find((script) => script.id === id) ?? null; },
    createElement(tag: string): FakeScript {
      assert.equal(tag, 'script');
      return { id: '', src: '', async: false };
    },
    head: {
      appendChild(script: FakeScript) {
        assert.equal(location.search, '', 'query must be removed before vendor loading');
        assert.equal(location.hash, '', 'fragment must be removed before vendor loading');
        scripts.push(script);
        return script;
      },
    },
  };
  const fakeWindow: Partial<Omit<Window, 'location' | 'history' | 'document'>> & Navigation = {
    localStorage, sessionStorage, location, history, document: fakeDocument,
  };
  replaceProperty(t, globalThis, 'window', fakeWindow);
  replaceProperty(t, globalThis, 'document', fakeDocument);
  replaceProperty(t, measurementConfig, 'clarityProjectId', 'clarityqa');
  replaceProperty(t, measurementConfig, 'gtmContainerId', 'GTM-QATEST');
  const consent = new FreshConsentManager();

  return { consent, scripts, fakeWindow, localStorage, sessionStorage };
}

function clarityQueue(harness: ReturnType<typeof setup>) {
  return harness.fakeWindow.clarity?.q;
}

function assertNoGoogleEffects(harness: ReturnType<typeof setup>) {
  assert.equal(harness.fakeWindow.dataLayer, undefined);
  assert.equal(harness.fakeWindow.__GOURMET_MEASUREMENT_DEBUG__, undefined);
  assert.equal(harness.scripts.some((script) => script.id === 'gourmet-growth-gtm'), false);
  assert.equal(harness.scripts.some((script) => script.src.includes('googletagmanager')), false);
}

describe('confirmation Clarity contract with real consent and vendor functions', () => {
  for (const referrer of ['https://qa.example/form2/bbq/', 'https://referrer.example/start/']) {
    it(`allows a clean absolute referrer ${referrer}`, (t) => {
      const harness = setup(t, JSON.stringify(savedConsent(true)), '/form2/request-received/', referrer);

      const cleanup = connectConfirmationClarity({ consent: harness.consent });
      t.after(cleanup);

      assert.equal(harness.scripts.length, 1);
      assert.deepEqual(clarityQueue(harness), [
        ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
      ]);
      assertNoGoogleEffects(harness);
    });
  }

  const blockedReferrers = [
    'https://qa.example/form2/bbq/?utm_source=synthetic-qa',
    'https://qa.example/form2/bbq/?phone=synthetic-qa&name=synthetic-name',
    'https://referrer.example/start/#details=synthetic-qa',
    'not-an-absolute-url',
  ];
  for (const referrer of blockedReferrers) {
    it(`blocks vendors and later consent changes for an unsafe referrer ${referrer}`, (t) => {
      const harness = setup(t, JSON.stringify(savedConsent(true)), '/form2/request-received/', referrer);

      const cleanup = connectConfirmationClarity({ consent: harness.consent });
      t.after(cleanup);

      assert.deepEqual(harness.localStorage.operations, []);
      assert.deepEqual(harness.scripts, []);
      assert.equal(harness.fakeWindow.clarity, undefined);
      harness.consent.rejectAll();
      harness.consent.acceptAll();
      assert.deepEqual(harness.scripts, []);
      assert.equal(harness.fakeWindow.clarity, undefined);
      assert.deepEqual(harness.sessionStorage.operations, []);
      assertNoGoogleEffects(harness);
    });
  }

  it('blocks vendors and later consent changes when the referrer getter throws', (t) => {
    const harness = setup(t, JSON.stringify(savedConsent(true)));
    Object.defineProperty(harness.fakeWindow.document, 'referrer', {
      get() { throw new Error('Referrer access denied'); },
    });

    const cleanup = connectConfirmationClarity({ consent: harness.consent });
    t.after(cleanup);

    assert.deepEqual(harness.localStorage.operations, []);
    assert.deepEqual(harness.scripts, []);
    harness.consent.acceptAll();
    assert.deepEqual(harness.scripts, []);
    assert.equal(harness.fakeWindow.clarity, undefined);
    assertNoGoogleEffects(harness);
  });

  it('removes an incoming query and fragment before the real vendor function creates a script', (t) => {
    const harness = setup(t, JSON.stringify(savedConsent(true)),
      '/form2/request-received/?phone=synthetic-qa#name=synthetic-name');
    const originalHistoryState = harness.fakeWindow.history.state;

    const cleanup = connectConfirmationClarity({ consent: harness.consent });
    t.after(cleanup);

    assert.equal(harness.fakeWindow.location.pathname, '/form2/request-received/');
    assert.equal(harness.fakeWindow.location.search, '');
    assert.equal(harness.fakeWindow.location.hash, '');
    assert.equal(harness.fakeWindow.history.state, originalHistoryState);
    assert.equal(harness.scripts.length, 1);
    assert.equal(JSON.stringify(clarityQueue(harness)).includes('synthetic-qa'), false);
    assertNoGoogleEffects(harness);
  });

  it('does not read consent or load vendors when history cannot sanitize the URL', (t) => {
    const harness = setup(t, JSON.stringify(savedConsent(true)),
      '/form2/request-received/?phone=synthetic-qa#name=synthetic-name');
    harness.fakeWindow.history.replaceState = () => { throw new Error('History unavailable'); };

    const cleanup = connectConfirmationClarity({ consent: harness.consent });
    t.after(cleanup);

    assert.deepEqual(harness.localStorage.operations, []);
    assert.deepEqual(harness.scripts, []);
    assert.equal(harness.fakeWindow.clarity, undefined);
    harness.consent.acceptAll();
    assert.deepEqual(harness.scripts, []);
    assert.equal(harness.fakeWindow.clarity, undefined);
    assertNoGoogleEffects(harness);
  });

  it('loads one async QA Clarity script from stored analytics consent without GTM', (t) => {
    const harness = setup(t, JSON.stringify(savedConsent(true)));

    const cleanup = connectConfirmationClarity({ consent: harness.consent });
    t.after(cleanup);

    assert.deepEqual(harness.scripts, [{
      id: 'gourmet-growth-clarity',
      src: 'https://www.clarity.ms/tag/clarityqa',
      async: true,
    }]);
    assert.deepEqual(clarityQueue(harness), [
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
    ]);
    assert.deepEqual(harness.localStorage.operations, [`get:${CONSENT_KEY}`]);
    assert.deepEqual(harness.sessionStorage.operations, []);
    assertNoGoogleEffects(harness);
  });

  const blockedCases: [string, string | null][] = [
    ['no saved preference', null],
    ['explicit rejection', JSON.stringify(savedConsent())],
    ['advertising-only consent', JSON.stringify(savedConsent(false, true))],
    ['malformed JSON', '{invalid-json'],
    ['an unsupported consent version', JSON.stringify({ ...savedConsent(true), version: 2 })],
    ['an invalid consent value', JSON.stringify({ ...savedConsent(true), ad_storage: 'unknown' })],
    ['an incomplete stored preference', JSON.stringify({ version: 1, analytics_storage: 'granted' })],
  ];

  for (const [label, raw] of blockedCases) {
    it(`does not create a Clarity script or queue for ${label}`, (t) => {
      const harness = setup(t, raw);

      const cleanup = connectConfirmationClarity({ consent: harness.consent });
      t.after(cleanup);

      assert.deepEqual(harness.scripts, []);
      assert.equal(harness.fakeWindow.clarity, undefined);
      assert.equal(harness.consent.getEffectiveState().analytics_storage, 'denied');
      assert.deepEqual(harness.sessionStorage.operations, []);
      assertNoGoogleEffects(harness);
    });
  }

  it('tolerates inaccessible storage and still applies a later explicit in-memory choice', (t) => {
    const harness = setup(t, JSON.stringify(savedConsent(true)));
    harness.localStorage.failReads = true;
    harness.localStorage.failWrites = true;
    let cleanup: (() => void) | undefined;

    assert.doesNotThrow(() => { cleanup = connectConfirmationClarity({ consent: harness.consent }); });
    t.after(() => cleanup?.());
    assert.deepEqual(harness.scripts, []);
    assert.equal(harness.fakeWindow.clarity, undefined);
    assert.equal(harness.consent.getEffectiveState().analytics_storage, 'denied');

    assert.doesNotThrow(() => harness.consent.choose(true, false));

    assert.equal(harness.scripts.length, 1);
    assert.equal(harness.consent.getEffectiveState().analytics_storage, 'granted');
    assert.deepEqual(clarityQueue(harness), [
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
    ]);
    assertNoGoogleEffects(harness);
  });

  it('queues grant, revoke, and regrant in order before the script loads, without duplication', (t) => {
    const harness = setup(t);
    const cleanup = connectConfirmationClarity({ consent: harness.consent });
    t.after(cleanup);

    harness.consent.choose(true, false);
    const originalScript = harness.scripts[0];
    const originalClarity = harness.fakeWindow.clarity;
    harness.consent.choose(false, true);
    harness.consent.choose(true, true);

    assert.equal(harness.scripts.length, 1);
    assert.equal(harness.scripts[0], originalScript);
    assert.equal(harness.fakeWindow.clarity, originalClarity);
    assert.deepEqual(clarityQueue(harness), [
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
      ['consentv2', { ad_Storage: 'granted', analytics_Storage: 'denied' }],
      ['consent', false],
      ['consentv2', { ad_Storage: 'granted', analytics_Storage: 'granted' }],
    ]);
    const persisted = JSON.parse(harness.localStorage.values.get(CONSENT_KEY)!);
    assert.equal(persisted.analytics_storage, 'granted');
    assert.equal(persisted.ad_storage, 'granted');
    assertNoGoogleEffects(harness);
  });

  it('deduplicates the script across StrictMode remounts and stops commands after cleanup', (t) => {
    const harness = setup(t, JSON.stringify(savedConsent(true)));
    const cleanupFirstMount = connectConfirmationClarity({ consent: harness.consent });
    const originalScript = harness.scripts[0];
    const originalClarity = harness.fakeWindow.clarity;

    cleanupFirstMount();
    assert.equal(clarityQueue(harness)?.length, 1);
    const cleanupSecondMount = connectConfirmationClarity({ consent: harness.consent });
    t.after(cleanupSecondMount);
    harness.consent.rejectAll();

    assert.equal(harness.scripts.length, 1);
    assert.equal(harness.scripts[0], originalScript);
    assert.equal(harness.fakeWindow.clarity, originalClarity);
    // Exactly one denial pair proves only the remounted listener responds.
    assert.deepEqual(clarityQueue(harness), [
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
      ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'denied' }],
      ['consent', false],
    ]);
    const commandsAfterCleanup = structuredClone(clarityQueue(harness));
    cleanupSecondMount();
    harness.consent.acceptAll();
    harness.consent.rejectAll();
    assert.deepEqual(clarityQueue(harness), commandsAfterCleanup);
    assert.equal(harness.scripts.length, 1);
    assertNoGoogleEffects(harness);
  });

  it('leaves pending events and milestones untouched across grants, rejection, and remounts', (t) => {
    const harness = setup(t, JSON.stringify(savedConsent(true, true)));
    const pending = JSON.stringify([
      { event: 'form_start', intent_cluster: 'synthetic-qa' },
      { event: 'form_complete', intent_cluster: 'synthetic-qa' },
      { event: 'generate_lead', transaction_id: 'synthetic-transaction' },
    ]);
    const milestones = JSON.stringify(['form_start', 'form_complete', 'generate_lead']);
    harness.sessionStorage.values.set(PENDING_KEY, pending);
    harness.sessionStorage.values.set(MILESTONES_KEY, milestones);
    const originalStorage = [...harness.sessionStorage.values];

    const cleanupFirstMount = connectConfirmationClarity({ consent: harness.consent });
    harness.consent.rejectAll();
    harness.consent.acceptAll();
    cleanupFirstMount();
    const cleanupSecondMount = connectConfirmationClarity({ consent: harness.consent });
    t.after(cleanupSecondMount);

    assert.deepEqual([...harness.sessionStorage.values], originalStorage);
    assert.deepEqual(harness.sessionStorage.operations, []);
    assert.equal(JSON.stringify(clarityQueue(harness)).includes('synthetic-transaction'), false);
    assert.equal(JSON.stringify(clarityQueue(harness)).includes('form_complete'), false);
    assertNoGoogleEffects(harness);
  });

  for (const analytics of [true, false]) {
    it(`restores persisted analytics ${analytics ? 'acceptance' : 'rejection'} in a fresh consent manager`, (t) => {
      const harness = setup(t);
      const cleanupFirstMount = connectConfirmationClarity({ consent: harness.consent });
      harness.consent.choose(analytics, false);
      cleanupFirstMount();
      // Model a new document with the same localStorage but a fresh DOM and
      // consent instance, without fetching or executing any external code.
      harness.scripts.splice(0);
      delete harness.fakeWindow.clarity;
      const freshConsent = new FreshConsentManager();

      const cleanupSecondMount = connectConfirmationClarity({ consent: freshConsent });
      t.after(cleanupSecondMount);

      assert.equal(freshConsent.getEffectiveState().analytics_storage, analytics ? 'granted' : 'denied');
      assert.equal(harness.scripts.length, analytics ? 1 : 0);
      if (analytics) {
        assert.deepEqual(clarityQueue(harness), [
          ['consentv2', { ad_Storage: 'denied', analytics_Storage: 'granted' }],
        ]);
      } else {
        assert.equal(harness.fakeWindow.clarity, undefined);
      }
      assertNoGoogleEffects(harness);
    });
  }
});
