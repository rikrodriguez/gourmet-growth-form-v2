export const TELEMETRY_SCHEMA_VERSION = '1.0' as const;

export const STEP_INDEX = {
  guests: 1,
  service: 2,
  zip: 3,
  phone: 4,
  event_type: 5,
  date: 6,
  name: 7,
  complete: 8,
} as const;

export type StepId = keyof typeof STEP_INDEX;
export type StepIndex = (typeof STEP_INDEX)[StepId];

export type GuestAnswerValue = '10-25' | '26-50' | '51-100' | '101-200' | '201+' | 'not-sure';
export type ServiceAnswerValue = 'full-service' | 'buffet' | 'drop-off' | 'not-sure';
export type EventTypeAnswerValue = 'Wedding' | 'Birthday' | 'Corporate' | 'Graduation' | 'Memorial / Funeral' | 'Other';
export type DateAnswerValue = 'exact' | 'next-2-weeks' | 'this-month' | '1-3-months' | 'still-deciding';
export type AnswerValue = GuestAnswerValue | ServiceAnswerValue | EventTypeAnswerValue | DateAnswerValue;

export type AnswerSelectedProperties =
  | { question: 'guests'; value: GuestAnswerValue }
  | { question: 'service'; value: ServiceAnswerValue }
  | { question: 'event_type'; value: EventTypeAnswerValue }
  | { question: 'date'; value: DateAnswerValue };

export const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gbraid',
  'wbraid',
  'gad_source',
  'gad_campaignid',
  'adgroupid',
  'network',
  'matchtype',
  'device',
  'geo',
  'fbclid',
  'msclkid',
  'ttclid',
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type AttributionTouch = Partial<Record<AttributionKey, string>> & {
  captured_at: string;
  landing_path: string;
  landing_url_without_pii: string;
  referrer: string | null;
  intent_cluster: 'bbq';
};

export type AttributionContext = {
  first_touch: AttributionTouch;
  latest_touch: AttributionTouch;
};

export type ValidationCode =
  | 'guests_required'
  | 'service_required'
  | 'zip_invalid'
  | 'phone_invalid'
  | 'event_type_required'
  | 'date_required'
  | 'name_required';

export type TelemetryEventProperties = {
  session_started: { is_new_session: true };
  funnel_resumed: { resumed_step: StepId };
  step_viewed: Record<string, never>;
  answer_selected: AnswerSelectedProperties;
  step_completed: {
    zip_valid?: boolean;
    geo_resolved?: boolean;
    state?: string;
  };
  back_clicked: { from_step: StepId; to_step: StepId };
  validation_error: { code: ValidationCode };
  phone_captured: { valid: true; digit_count: 10 };
  form_completed: { completed_step_count: 7 };
  visibility_changed: { state: 'hidden' | 'visible' };
  page_exit_signal: { reason: 'pagehide'; last_step: StepId };
};

export type TelemetryEventName = keyof TelemetryEventProperties;

type TelemetryEventFor<Name extends TelemetryEventName> = {
  schema_version: typeof TELEMETRY_SCHEMA_VERSION;
  event_id: string;
  event_name: Name;
  occurred_at: string;
  visitor_id: string;
  session_id: string;
  intent_cluster: 'bbq';
  route: string;
  step_id: StepId;
  step_index: StepIndex;
  properties: TelemetryEventProperties[Name];
  experiment_id: null;
  variant_id: null;
  step_duration_ms: number | null;
  session_elapsed_ms: number;
  attribution: AttributionContext;
};

export type GourmetTelemetryEvent = {
  [Name in TelemetryEventName]: TelemetryEventFor<Name>;
}[TelemetryEventName];

export type TelemetryDebugSnapshot = {
  visitor_id: string;
  session_id: string;
  attribution: AttributionContext;
  events: GourmetTelemetryEvent[];
};

export type TelemetryLeadContext = {
  visitor_id: string;
  session_id: string;
  attribution: AttributionContext;
};

export type GourmetTelemetryDebug = {
  getSnapshot: () => TelemetryDebugSnapshot;
  getEvents: () => GourmetTelemetryEvent[];
  getPendingEvents: () => GourmetTelemetryEvent[];
};

declare global {
  interface Window {
    __GOURMET_TELEMETRY_DEBUG__?: GourmetTelemetryDebug;
  }
}
