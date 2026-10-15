import { consentManager } from './consent';
import { loadClarity, updateClarityConsent } from './vendors';

type ConfirmationClarityDependencies = {
  prepareUrl: () => boolean;
  consent: Pick<typeof consentManager, 'initialize' | 'getEffectiveState' | 'subscribe'>;
  load: typeof loadClarity;
  update: typeof updateClarityConsent;
};

type ConfirmationNavigation = {
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  history: Pick<History, 'state' | 'replaceState'>;
  document: Pick<Document, 'referrer'>;
};

/** No query or fragment is part of the confirmation contract. Apache's retired
 * route redirect can preserve a query, so sanitize the destination before any
 * optional vendor is loaded. The SDK also reads document.referrer, which this
 * page cannot rewrite: skip Clarity if that metadata is not safely parseable
 * or contains query/fragment/userinfo. Fail closed on unavailable browser APIs. */
export function prepareConfirmationUrl(navigation: ConfirmationNavigation = window): boolean {
  try {
    const { location, history, document } = navigation;
    if (!/^\/form2\/request-received\/?$/.test(location.pathname)) return false;
    if (location.search || location.hash) {
      history.replaceState(history.state, '', location.pathname);
    }
    if (location.search !== '' || location.hash !== '') return false;

    const referrer = document.referrer;
    if (typeof referrer !== 'string') return false;
    if (referrer === '') return true;
    const referringUrl = new URL(referrer);
    return (referringUrl.protocol === 'https:' || referringUrl.protocol === 'http:')
      && referringUrl.search === ''
      && referringUrl.hash === ''
      && referringUrl.username === ''
      && referringUrl.password === '';
  } catch {
    return false;
  }
}

/**
 * A full-page confirmation navigation needs its own consent-aware Clarity
 * bootstrap. Deliberately do not initialize the measurement event manager:
 * that would also load GTM and replay pending acquisition events here.
 */
export function connectConfirmationClarity({
  prepareUrl = prepareConfirmationUrl,
  consent = consentManager,
  load = loadClarity,
  update = updateClarityConsent,
}: Partial<ConfirmationClarityDependencies> = {}): () => void {
  if (!prepareUrl()) return () => {};
  consent.initialize();
  const apply = () => {
    const state = consent.getEffectiveState();
    if (state.analytics_storage === 'granted') load(state);
    else update(state);
  };
  const unsubscribe = consent.subscribe(apply);
  apply();
  // StrictMode cleanup must only remove the listener, not revoke consent or
  // remove the idempotent vendor script that may already be loading.
  return unsubscribe;
}
