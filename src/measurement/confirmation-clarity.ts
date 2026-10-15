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
};

/** No query or fragment is part of the confirmation contract. Apache's retired
 * route redirect can preserve a query, so sanitize the destination before any
 * optional vendor is loaded. If history is unavailable, fail closed. */
export function prepareConfirmationUrl(navigation: ConfirmationNavigation = window): boolean {
  try {
    const { location, history } = navigation;
    if (!/^\/form2\/request-received\/?$/.test(location.pathname)) return false;
    if (location.search || location.hash) {
      history.replaceState(history.state, '', location.pathname);
    }
    return location.search === '' && location.hash === '';
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
