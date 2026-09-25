import { consentManager } from './consent';
import { googleAdsConfigured, measurementConfig } from './config';
import type {
  MeasurementDebugSnapshot,
  MeasurementEvent,
  MeasurementEventName,
  MeasurementEventProperties,
  PersistedConsent,
} from './contracts';
import { MEASUREMENT_SCHEMA_VERSION } from './contracts';
import { pushMeasurementEvent, setDefaultConsent, updateGoogleConsent } from './data-layer';
import { loadClarity, loadGtm, updateClarityConsent } from './vendors';

const MILESTONES_STORAGE_KEY = 'gourmet_growth_measurement_milestones_v1';
const PENDING_STORAGE_KEY = 'gourmet_growth_measurement_pending_v1';
const MAX_PENDING_EVENTS = 20;

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function readStringArray(key: string): string[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function readPending(): MeasurementEvent[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(PENDING_STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is MeasurementEvent => (
      Boolean(value) && typeof value === 'object' && typeof (value as MeasurementEvent).event === 'string'
    )).slice(-MAX_PENDING_EVENTS);
  } catch {
    return [];
  }
}

class GourmetMeasurement {
  private initialized = false;
  private milestones = new Set<string>();
  private pending: MeasurementEvent[] = [];
  private emitted: MeasurementEvent[] = [];

  initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.milestones = new Set(readStringArray(MILESTONES_STORAGE_KEY));
    this.pending = readPending();
    setDefaultConsent();
    const saved = consentManager.initialize();
    if (saved) this.applyConsent(saved);
    consentManager.subscribe((consent) => {
      if (consent) this.applyConsent(consent);
    });
    this.exposeDebug();
  }

  formStart() {
    this.trackOnce('form_start', 'form_start', {});
  }

  stepComplete(properties: MeasurementEventProperties['form_step_complete']) {
    this.trackOnce(`form_step_complete:${properties.step_id}`, 'form_step_complete', properties);
  }

  phoneCapture() {
    this.trackOnce('phone_capture', 'phone_capture', { valid: true });
  }

  generateLead(transactionId: string) {
    this.trackOnce('generate_lead', 'generate_lead', { transaction_id: transactionId });
  }

  getServerConsentEvidence() {
    const consent = consentManager.getPreference();
    if (!consent) return null;
    return {
      version: consent.version,
      updated_at: consent.updated_at,
      ad_storage: consent.ad_storage,
      ad_user_data: consent.ad_user_data,
      ad_personalization: consent.ad_personalization,
    } as const;
  }

  formComplete() {
    this.trackOnce('form_complete', 'form_complete', {});
  }

  startNewFunnel() {
    this.milestones.clear();
    this.pending = [];
    this.persist();
    this.formStart();
  }

  private trackOnce<Name extends MeasurementEventName>(
    milestone: string,
    eventName: Name,
    properties: MeasurementEventProperties[Name],
  ) {
    this.initialize();
    if (this.milestones.has(milestone)) return;
    this.milestones.add(milestone);
    const event = {
      event: eventName,
      schema_version: MEASUREMENT_SCHEMA_VERSION,
      intent_cluster: 'bbq',
      measurement_environment: measurementConfig.environment,
      traffic_type: measurementConfig.environment === 'production' ? 'customer' : 'qa',
      analytics_eligible: Boolean(measurementConfig.ga4MeasurementId),
      ads_eligible: measurementConfig.environment === 'production' && googleAdsConfigured,
      ...properties,
    } as unknown as MeasurementEvent;
    const consent = consentManager.getPreference();
    const allowedNow = event.event === 'generate_lead'
      ? consent?.analytics_storage === 'granted' || consent?.ad_storage === 'granted'
      : consent?.analytics_storage === 'granted';
    if (consent && !allowedNow) {
      this.persist();
      return;
    }
    this.pending = [...this.pending, event].slice(-MAX_PENDING_EVENTS);
    this.persist();
    this.flush();
  }

  private applyConsent(consent: PersistedConsent) {
    updateGoogleConsent(consent);
    updateClarityConsent(consent);
    if (consent.analytics_storage === 'granted' || consent.ad_storage === 'granted') loadGtm();
    if (consent.analytics_storage === 'granted') loadClarity(consent);
    if (consent.analytics_storage === 'denied' && consent.ad_storage === 'denied') {
      this.pending = [];
      this.persist();
      return;
    }
    this.flush();
  }

  private flush() {
    const consent = consentManager.getPreference();
    if (!consent) return;
    const remaining: MeasurementEvent[] = [];
    for (const event of this.pending) {
      const isAnalyticsEvent = event.event !== 'generate_lead';
      const allowed = isAnalyticsEvent
        ? consent.analytics_storage === 'granted'
        : consent.analytics_storage === 'granted' || consent.ad_storage === 'granted';
      if (!allowed) {
        remaining.push(event);
        continue;
      }
      const emittedEvent = {
        ...event,
        analytics_eligible: event.analytics_eligible && consent.analytics_storage === 'granted',
        ads_eligible: event.ads_eligible
          && consent.ad_storage === 'granted'
          && consent.ad_user_data === 'granted',
      } as MeasurementEvent;
      pushMeasurementEvent(emittedEvent);
      this.emitted = [...this.emitted, emittedEvent].slice(-MAX_PENDING_EVENTS);
    }
    this.pending = remaining;
    this.persist();
  }

  private persist() {
    try {
      window.sessionStorage.setItem(MILESTONES_STORAGE_KEY, JSON.stringify([...this.milestones]));
      window.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(this.pending));
    } catch {
      // Measurement is optional and never blocks quote functionality.
    }
  }

  private snapshot(): MeasurementDebugSnapshot {
    return clone({
      consent: consentManager.getPreference(),
      pending_events: this.pending,
      emitted_events: this.emitted,
      configuration: {
        environment: measurementConfig.environment,
        gtm_configured: Boolean(measurementConfig.gtmContainerId),
        ga4_configured: Boolean(measurementConfig.ga4MeasurementId),
        google_ads_configured: googleAdsConfigured,
        clarity_configured: Boolean(measurementConfig.clarityProjectId),
      },
    });
  }

  private exposeDebug() {
    if (measurementConfig.environment === 'production') return;
    window.__GOURMET_MEASUREMENT_DEBUG__ = { getSnapshot: () => this.snapshot() };
  }
}

export const measurement = new GourmetMeasurement();
