import type { ConsentState, PersistedConsent } from './contracts';

const CONSENT_STORAGE_KEY = 'gourmet_growth_measurement_consent_v1';
const DENIED: ConsentState = {
  analytics_storage: 'denied',
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
};

type ConsentListener = (consent: PersistedConsent | null) => void;

function parseConsent(raw: string | null): PersistedConsent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PersistedConsent>;
    const allowed = new Set(['granted', 'denied']);
    if (
      value.version === 1
      && typeof value.updated_at === 'string'
      && allowed.has(value.analytics_storage ?? '')
      && allowed.has(value.ad_storage ?? '')
      && allowed.has(value.ad_user_data ?? '')
      && allowed.has(value.ad_personalization ?? '')
    ) {
      return value as PersistedConsent;
    }
  } catch {
    // Invalid or old consent is replaced only after an explicit user choice.
  }
  return null;
}

class ConsentManager {
  private current: PersistedConsent | null = null;
  private initialized = false;
  private listeners = new Set<ConsentListener>();

  initialize(): PersistedConsent | null {
    if (this.initialized) return this.current;
    this.initialized = true;
    try {
      this.current = parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
    } catch {
      this.current = null;
    }
    return this.current;
  }

  getPreference(): PersistedConsent | null {
    return this.initialize();
  }

  getEffectiveState(): ConsentState {
    return this.current ?? DENIED;
  }

  choose(analytics: boolean, ads: boolean): PersistedConsent {
    const value: PersistedConsent = {
      version: 1,
      updated_at: new Date().toISOString(),
      analytics_storage: analytics ? 'granted' : 'denied',
      ad_storage: ads ? 'granted' : 'denied',
      ad_user_data: ads ? 'granted' : 'denied',
      ad_personalization: ads ? 'granted' : 'denied',
    };
    this.current = value;
    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // The explicit choice still applies for the current page.
    }
    this.listeners.forEach((listener) => listener(value));
    return value;
  }

  acceptAll() {
    return this.choose(true, true);
  }

  rejectAll() {
    return this.choose(false, false);
  }

  subscribe(listener: ConsentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const consentManager = new ConsentManager();
