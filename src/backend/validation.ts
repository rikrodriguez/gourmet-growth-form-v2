import {
  ATTRIBUTION_KEYS,
  STEP_INDEX,
  type AttributionContext,
  type AttributionTouch,
  type GourmetTelemetryEvent,
  type StepId,
  type TelemetryEventName,
} from '../telemetry/types';
import type { CapturePhoneInput, EventRejection, LeadAnswers } from './contracts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PII_KEYS = new Set([
  'phone',
  'phonenumber',
  'name',
  'firstname',
  'email',
  'address',
  'customer',
  'answers',
  'formdata',
]);

const EVENT_NAMES = new Set<TelemetryEventName>([
  'session_started',
  'funnel_resumed',
  'step_viewed',
  'answer_selected',
  'step_completed',
  'back_clicked',
  'validation_error',
  'phone_captured',
  'form_completed',
  'visibility_changed',
  'page_exit_signal',
]);

const STEPS = new Set<StepId>(Object.keys(STEP_INDEX) as StepId[]);
const GUEST_VALUES = new Set(['10-25', '26-50', '51-100', '101-200', '201+', 'not-sure']);
const SERVICE_VALUES = new Set(['full-service', 'buffet', 'drop-off', 'not-sure']);
const EVENT_TYPE_VALUES = new Set(['Wedding', 'Birthday', 'Corporate', 'Graduation', 'Memorial / Funeral', 'Other']);
const DATE_VALUES = new Set(['exact', 'next-2-weeks', 'this-month', '1-3-months', 'still-deciding']);
const VALIDATION_CODES = new Set([
  'guests_required', 'service_required', 'zip_invalid', 'phone_invalid',
  'event_type_required', 'date_required', 'name_required',
]);
const DATE_WINDOWS = DATE_VALUES;
const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedString(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function containsLikelyPii(value: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value) || /(?:\+?\d[\s().-]*){7,}/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (!isBoundedString(value, 40)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function findPiiKey(value: unknown, depth = 0): string | null {
  if (depth > 12) return '__maximum_depth_exceeded__';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPiiKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, '');
    if (PII_KEYS.has(normalized)) return key;
    const found = findPiiKey(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function validateAttributionTouch(value: unknown): value is AttributionTouch {
  if (!isRecord(value)) return false;
  const metadataKeys = ['captured_at', 'landing_path', 'landing_url_without_pii', 'referrer', 'intent_cluster'];
  if (!hasOnlyKeys(value, [...ATTRIBUTION_KEYS, ...metadataKeys])) return false;
  if (!isIsoTimestamp(value.captured_at)) return false;
  if (!isBoundedString(value.landing_path, 300) || !value.landing_path.startsWith('/') || /[?#]/.test(value.landing_path) || containsLikelyPii(value.landing_path)) return false;
  if (!isBoundedString(value.landing_url_without_pii, 500) || /[?#]/.test(value.landing_url_without_pii) || containsLikelyPii(value.landing_url_without_pii)) return false;
  try {
    const url = new URL(value.landing_url_without_pii);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
  } catch {
    return false;
  }
  if (value.referrer !== null && value.referrer !== undefined) {
    if (!isBoundedString(value.referrer, 200) || containsLikelyPii(value.referrer)) return false;
    try {
      const referrer = new URL(value.referrer);
      if (!['http:', 'https:'].includes(referrer.protocol) || referrer.origin !== value.referrer) return false;
    } catch {
      return false;
    }
  }
  if (value.intent_cluster !== 'bbq') return false;
  for (const key of ATTRIBUTION_KEYS) {
    const candidate = value[key];
    if (candidate !== undefined && (!isBoundedString(candidate, 200) || containsLikelyPii(candidate))) return false;
  }
  return findPiiKey(value) === null;
}

export function validateAttribution(value: unknown): value is AttributionContext {
  return isRecord(value)
    && hasOnlyKeys(value, ['first_touch', 'latest_touch'])
    && validateAttributionTouch(value.first_touch)
    && validateAttributionTouch(value.latest_touch);
}

function validateProperties(eventName: TelemetryEventName, stepId: StepId, value: unknown): boolean {
  if (!isRecord(value) || findPiiKey(value)) return false;

  switch (eventName) {
    case 'session_started':
      return hasOnlyKeys(value, ['is_new_session']) && value.is_new_session === true;
    case 'funnel_resumed':
      return hasOnlyKeys(value, ['resumed_step']) && STEPS.has(value.resumed_step as StepId);
    case 'step_viewed':
      return Object.keys(value).length === 0;
    case 'answer_selected': {
      if (!hasOnlyKeys(value, ['question', 'value']) || typeof value.value !== 'string') return false;
      if (value.question === 'guests') return GUEST_VALUES.has(value.value);
      if (value.question === 'service') return SERVICE_VALUES.has(value.value);
      if (value.question === 'event_type') return EVENT_TYPE_VALUES.has(value.value);
      if (value.question === 'date') return DATE_VALUES.has(value.value);
      return false;
    }
    case 'step_completed':
      return hasOnlyKeys(value, ['zip_valid', 'geo_resolved', 'state'])
        && (value.zip_valid === undefined || typeof value.zip_valid === 'boolean')
        && (value.geo_resolved === undefined || typeof value.geo_resolved === 'boolean')
        && (value.state === undefined || typeof value.state === 'string' && /^[A-Z]{2}$/.test(value.state))
        && (stepId === 'zip' || Object.keys(value).length === 0);
    case 'back_clicked':
      return hasOnlyKeys(value, ['from_step', 'to_step'])
        && STEPS.has(value.from_step as StepId)
        && STEPS.has(value.to_step as StepId);
    case 'validation_error':
      return hasOnlyKeys(value, ['code']) && VALIDATION_CODES.has(value.code as string);
    case 'phone_captured':
      return hasOnlyKeys(value, ['valid', 'digit_count']) && value.valid === true && value.digit_count === 10;
    case 'form_completed':
      return hasOnlyKeys(value, ['completed_step_count']) && value.completed_step_count === 7;
    case 'visibility_changed':
      return hasOnlyKeys(value, ['state']) && (value.state === 'hidden' || value.state === 'visible');
    case 'page_exit_signal':
      return hasOnlyKeys(value, ['reason', 'last_step'])
        && value.reason === 'pagehide'
        && STEPS.has(value.last_step as StepId);
  }
}

export function validateEvent(value: unknown, now = Date.now()): { event?: GourmetTelemetryEvent; rejection?: Omit<EventRejection, 'index'> } {
  const eventId = isRecord(value) && isUuid(value.event_id) ? value.event_id : null;
  if (!isRecord(value)) return { rejection: { event_id: null, code: 'invalid_event' } };
  const requiredKeys = [
    'schema_version', 'event_id', 'event_name', 'occurred_at', 'visitor_id', 'session_id',
    'intent_cluster', 'route', 'step_id', 'step_index', 'properties', 'experiment_id',
    'variant_id', 'step_duration_ms', 'session_elapsed_ms', 'attribution',
  ];
  if (!hasOnlyKeys(value, requiredKeys) || requiredKeys.some((key) => !(key in value))) {
    return { rejection: { event_id: eventId, code: 'invalid_shape' } };
  }
  if (findPiiKey(value.properties) || findPiiKey(value.attribution)) {
    return { rejection: { event_id: eventId, code: 'pii_key_rejected' } };
  }
  if (!isUuid(value.event_id) || !isUuid(value.visitor_id) || !isUuid(value.session_id)) {
    return { rejection: { event_id: eventId, code: 'invalid_uuid' } };
  }
  if (value.schema_version !== '1.0' || !EVENT_NAMES.has(value.event_name as TelemetryEventName)) {
    return { rejection: { event_id: eventId, code: 'unsupported_contract' } };
  }
  if (!isIsoTimestamp(value.occurred_at)) return { rejection: { event_id: eventId, code: 'invalid_occurred_at' } };
  const occurred = Date.parse(value.occurred_at);
  if (occurred < now - MAX_EVENT_AGE_MS || occurred > now + MAX_CLOCK_SKEW_MS) {
    return { rejection: { event_id: eventId, code: 'occurred_at_out_of_range' } };
  }
  if (value.intent_cluster !== 'bbq') return { rejection: { event_id: eventId, code: 'invalid_intent_cluster' } };
  if (!isBoundedString(value.route, 300) || !value.route.startsWith('/') || /[?#]/.test(value.route)) {
    return { rejection: { event_id: eventId, code: 'invalid_route' } };
  }
  if (!STEPS.has(value.step_id as StepId) || STEP_INDEX[value.step_id as StepId] !== value.step_index) {
    return { rejection: { event_id: eventId, code: 'invalid_step' } };
  }
  if (value.experiment_id !== null || value.variant_id !== null) {
    return { rejection: { event_id: eventId, code: 'experiments_not_enabled' } };
  }
  const stepDuration = value.step_duration_ms;
  if (stepDuration !== null && (typeof stepDuration !== 'number' || !Number.isInteger(stepDuration) || stepDuration < 0 || stepDuration > 86_400_000)) {
    return { rejection: { event_id: eventId, code: 'invalid_step_duration' } };
  }
  const sessionElapsed = value.session_elapsed_ms;
  if (typeof sessionElapsed !== 'number' || !Number.isInteger(sessionElapsed) || sessionElapsed < 0 || sessionElapsed > MAX_EVENT_AGE_MS) {
    return { rejection: { event_id: eventId, code: 'invalid_session_elapsed' } };
  }
  if (!validateAttribution(value.attribution)) return { rejection: { event_id: eventId, code: 'invalid_attribution' } };
  if (!validateProperties(value.event_name as TelemetryEventName, value.step_id as StepId, value.properties)) {
    return { rejection: { event_id: eventId, code: 'invalid_properties' } };
  }
  return { event: value as GourmetTelemetryEvent };
}

export function normalizeUsPhone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null;
  let digits = value.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return digits;
}

export function validateLeadAnswers(value: unknown, allowed: readonly (keyof LeadAnswers)[]): LeadAnswers | null {
  if (value === undefined) return {};
  if (!isRecord(value) || !hasOnlyKeys(value, allowed)) return null;
  const result: LeadAnswers = {};
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'exact_date' && raw === null) {
      result.exact_date = null;
      continue;
    }
    if (!isBoundedString(raw, key === 'first_name' ? 80 : 300)) return null;
    if (key === 'guest_range' && !GUEST_VALUES.has(raw)) return null;
    if (key === 'service_style' && !SERVICE_VALUES.has(raw)) return null;
    if (key === 'date_window' && !DATE_WINDOWS.has(raw)) return null;
    if (key === 'exact_date' && (!ISO_DATE_PATTERN.test(raw) || !Number.isFinite(Date.parse(`${raw}T00:00:00Z`)))) return null;
    if (key === 'zip_code' && !/^\d{5}$/.test(raw)) return null;
    if (key === 'event_type' && raw.trim().length < 2) return null;
    if (key === 'first_name' && raw.trim().length < 1) return null;
    result[key as keyof LeadAnswers] = raw.trim();
  }
  return result;
}

export function validateCapturePhone(value: unknown): { input?: CapturePhoneInput; phone?: string; code?: string } {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'visitor_id', 'session_id', 'phone', 'intent_cluster', 'idempotency_key', 'attribution', 'answers',
  ])) return { code: 'invalid_shape' };
  if (!isUuid(value.visitor_id) || !isUuid(value.session_id) || !isUuid(value.idempotency_key)) return { code: 'invalid_uuid' };
  if (value.intent_cluster !== 'bbq') return { code: 'invalid_intent_cluster' };
  const phone = normalizeUsPhone(value.phone);
  if (!phone) return { code: 'invalid_phone' };
  if (value.attribution !== undefined && !validateAttribution(value.attribution)) return { code: 'invalid_attribution' };
  const answers = validateLeadAnswers(value.answers, ['guest_range', 'service_style', 'zip_code']);
  if (!answers) return { code: 'invalid_answers' };
  return { input: { ...value, phone, answers } as CapturePhoneInput, phone };
}

export function validateLeadPatch(value: unknown): LeadAnswers | null {
  return validateLeadAnswers(value, [
    'event_type', 'date_window', 'exact_date', 'first_name',
    'guest_range', 'service_style', 'zip_code',
  ]);
}
