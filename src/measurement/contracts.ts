import type { StepId, StepIndex } from '../telemetry/types';

export const MEASUREMENT_SCHEMA_VERSION = '1.0' as const;

export type ConsentValue = 'granted' | 'denied';

export type ConsentState = {
  analytics_storage: ConsentValue;
  ad_storage: ConsentValue;
  ad_user_data: ConsentValue;
  ad_personalization: ConsentValue;
};

export type PersistedConsent = ConsentState & {
  version: 1;
  updated_at: string;
};

export type MeasurementEventProperties = {
  form_start: Record<string, never>;
  form_step_complete: {
    step_id: StepId;
    step_index: StepIndex;
    guest_range?: string;
    service_style?: string;
    event_type?: string;
    date_window?: string;
    geo_state?: string;
  };
  phone_capture: { valid: true };
  generate_lead: Record<string, never>;
  form_complete: Record<string, never>;
};

export type MeasurementEventName = keyof MeasurementEventProperties;

export type MeasurementEventFor<Name extends MeasurementEventName> = {
  event: Name;
  schema_version: typeof MEASUREMENT_SCHEMA_VERSION;
  intent_cluster: 'bbq';
  measurement_environment: 'staging' | 'production';
  traffic_type: 'qa' | 'customer';
  analytics_eligible: boolean;
  ads_eligible: boolean;
} & MeasurementEventProperties[Name];

export type MeasurementEvent = {
  [Name in MeasurementEventName]: MeasurementEventFor<Name>;
}[MeasurementEventName];

export type MeasurementDebugSnapshot = {
  consent: PersistedConsent | null;
  pending_events: MeasurementEvent[];
  emitted_events: MeasurementEvent[];
  configuration: {
    environment: 'staging' | 'production';
    gtm_configured: boolean;
    ga4_configured: boolean;
    google_ads_configured: boolean;
    clarity_configured: boolean;
  };
};

declare global {
  interface Window {
    dataLayer?: unknown[];
    clarity?: ((command: string, ...args: unknown[]) => void) & { q?: unknown[][] };
    __GOURMET_MEASUREMENT_DEBUG__?: {
      getSnapshot: () => MeasurementDebugSnapshot;
    };
  }
}
