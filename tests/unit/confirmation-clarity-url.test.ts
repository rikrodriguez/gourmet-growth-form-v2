import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prepareConfirmationUrl } from '../../src/measurement/confirmation-clarity';

type Navigation = NonNullable<Parameters<typeof prepareConfirmationUrl>[0]>;
type ReplaceCall = { state: unknown; unused: string; url: string | URL | null | undefined };

function navigationFixture(pathname = '/form2/request-received/', search = '', hash = '') {
  const calls: ReplaceCall[] = [];
  const location: Navigation['location'] = { pathname, search, hash };
  const state = { syntheticNavigation: { value: 'preserve-me' } };
  const history: { state: unknown; replaceState: Navigation['history']['replaceState'] } = {
    state,
    replaceState(nextState, unused, url) {
      calls.push({ state: nextState, unused, url });
      const next = new URL(String(url), 'https://qa.example');
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
      this.state = nextState;
    },
  };
  const navigation: Navigation = { location, history };
  return { navigation, location, history, state, calls };
}

describe('confirmation URL privacy guard', () => {
  for (const pathname of ['/form2/request-received/', '/form2/request-received']) {
    it(`accepts the clean confirmation path ${pathname} without replacing history`, () => {
      const fixture = navigationFixture(pathname);

      assert.equal(prepareConfirmationUrl(fixture.navigation), true);

      assert.deepEqual(fixture.calls, []);
      assert.equal(fixture.location.pathname, pathname);
      assert.equal(fixture.history.state, fixture.state);
    });
  }

  const dirtyCases = [
    { label: 'query only', pathname: '/form2/request-received/', search: '?phone=synthetic-qa', hash: '' },
    { label: 'fragment only', pathname: '/form2/request-received/', search: '', hash: '#name=synthetic-qa' },
    { label: 'query and fragment', pathname: '/form2/request-received/', search: '?id=synthetic-qa', hash: '#details=synthetic-qa' },
    { label: 'query and fragment without a trailing slash', pathname: '/form2/request-received', search: '?id=synthetic-qa', hash: '#details=synthetic-qa' },
  ];
  for (const { label, pathname, search, hash } of dirtyCases) {
    it(`removes ${label} while preserving pathname and the exact history state`, () => {
      const fixture = navigationFixture(pathname, search, hash);

      assert.equal(prepareConfirmationUrl(fixture.navigation), true);

      assert.deepEqual(fixture.calls, [{ state: fixture.state, unused: '', url: pathname }]);
      assert.equal(fixture.calls[0].state, fixture.state);
      assert.equal(fixture.history.state, fixture.state);
      assert.deepEqual(fixture.location, { pathname, search: '', hash: '' });
      assert.equal(prepareConfirmationUrl(fixture.navigation), true);
      assert.equal(fixture.calls.length, 1, 'an already sanitized URL must not rewrite history again');
    });
  }

  for (const pathname of [
    '/form2/bbq/',
    '/form2/thank-you/',
    '/form2/request-received/extra',
    '/form2/request-received//',
    '/form2/request-received-other',
    '/other/form2/request-received/',
  ]) {
    it(`rejects the unrelated path ${pathname} without changing its URL`, () => {
      const fixture = navigationFixture(pathname, '?id=synthetic-qa', '#details=synthetic-qa');
      const originalLocation = { ...fixture.location };

      assert.equal(prepareConfirmationUrl(fixture.navigation), false);

      assert.deepEqual(fixture.calls, []);
      assert.deepEqual(fixture.location, originalLocation);
    });
  }

  it('fails closed when history replacement throws', () => {
    const fixture = navigationFixture('/form2/request-received/', '?id=synthetic-qa');
    fixture.history.replaceState = () => { throw new Error('History access denied'); };

    assert.equal(prepareConfirmationUrl(fixture.navigation), false);
    assert.equal(fixture.location.search, '?id=synthetic-qa');
  });

  it('fails closed when history replacement is a no-op', () => {
    const fixture = navigationFixture('/form2/request-received/', '?id=synthetic-qa', '#details=synthetic-qa');
    fixture.history.replaceState = () => {};

    assert.equal(prepareConfirmationUrl(fixture.navigation), false);
    assert.equal(fixture.location.search, '?id=synthetic-qa');
    assert.equal(fixture.location.hash, '#details=synthetic-qa');
  });

  it('fails closed if replacement leaves a fragment behind', () => {
    const fixture = navigationFixture('/form2/request-received/', '?id=synthetic-qa', '#details=synthetic-qa');
    fixture.history.replaceState = () => { fixture.location.search = ''; };

    assert.equal(prepareConfirmationUrl(fixture.navigation), false);
    assert.equal(fixture.location.hash, '#details=synthetic-qa');
  });

  for (const field of ['location', 'history'] as const) {
    it(`fails closed when reading ${field} throws`, () => {
      const fixture = navigationFixture('/form2/request-received/', '?id=synthetic-qa');
      Object.defineProperty(fixture.navigation, field, {
        get() { throw new Error(`${field} access denied`); },
      });

      assert.equal(prepareConfirmationUrl(fixture.navigation), false);
      assert.deepEqual(fixture.calls, []);
    });
  }

  for (const field of ['pathname', 'search', 'hash'] as const) {
    it(`fails closed when reading location.${field} throws`, () => {
      const fixture = navigationFixture();
      Object.defineProperty(fixture.location, field, {
        get() { throw new Error(`${field} access denied`); },
      });

      assert.equal(prepareConfirmationUrl(fixture.navigation), false);
      assert.deepEqual(fixture.calls, []);
    });
  }

  it('fails closed when reading the history state throws', () => {
    const fixture = navigationFixture('/form2/request-received/', '?id=synthetic-qa');
    Object.defineProperty(fixture.history, 'state', {
      get() { throw new Error('History state access denied'); },
    });

    assert.equal(prepareConfirmationUrl(fixture.navigation), false);
    assert.deepEqual(fixture.calls, []);
  });
});
