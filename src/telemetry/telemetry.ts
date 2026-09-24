import { resolveAttribution } from './attribution';
import { gourmetApiBaseUrl } from '../api/config';
import { resolveTelemetryIdentity, TelemetryIdentity } from './identity';
import { createTelemetryTransport, deliverTelemetryBatch } from './transport';
import {
  AnswerSelectedProperties,
  AttributionContext,
  DateAnswerValue,
  EventTypeAnswerValue,
  GourmetTelemetryEvent,
  GuestAnswerValue,
  ServiceAnswerValue,
  STEP_INDEX,
  StepId,
  TELEMETRY_SCHEMA_VERSION,
  TelemetryDebugSnapshot,
  TelemetryLeadContext,
  TelemetryEventName,
  TelemetryEventProperties,
  ValidationCode,
} from './types';

const QUEUE_STORAGE_KEY = 'gourmet_growth_telemetry_queue_v1';
const DEBUG_HISTORY_STORAGE_KEY = 'gourmet_growth_telemetry_debug_history_v1';
const COMPLETION_STORAGE_KEY = 'gourmet_growth_telemetry_completed_v1';
const QUEUE_LIMIT = 100;
const DELIVERY_BATCH_SIZE = 20;
const MAX_DELIVERY_RETRIES = 5;
const transport = createTelemetryTransport(gourmetApiBaseUrl);
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

const ANSWER_VALUES = {
  guests: new Set<GuestAnswerValue>(['10-25', '26-50', '51-100', '101-200', '201+', 'not-sure']),
  service: new Set<ServiceAnswerValue>(['full-service', 'buffet', 'drop-off', 'not-sure']),
  event_type: new Set<EventTypeAnswerValue>(['Wedding', 'Birthday', 'Corporate', 'Graduation', 'Memorial / Funeral', 'Other']),
  date: new Set<DateAnswerValue>(['exact', 'next-2-weeks', 'this-month', '1-3-months', 'still-deciding']),
};

type StepCompletedProperties = TelemetryEventProperties['step_completed'];

function roundedMilliseconds(value: number): number {
  return Math.max(0, Math.round(value));
}

function clone<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

class GourmetTelemetry {
  private initialized = false;
  private identity: TelemetryIdentity | null = null;
  private attribution: AttributionContext | null = null;
  private events: GourmetTelemetryEvent[] = [];
  private debugEvents: GourmetTelemetryEvent[] = [];
  private currentStep: StepId = 'guests';
  private stepStartedAt = new Map<StepId, number>();
  private completedCurrentView = false;
  private completionTracked = false;
  private phoneCapturedCurrentView = false;
  private lastVisibility: 'hidden' | 'visible' | null = null;
  private pagehideTracked = false;
  private deliveryTimer: number | null = null;
  private deliveryInFlight = false;
  private deliveryRetry = 0;

  initialize(currentStep: StepId) {
    if (this.initialized) return;

    try {
      this.identity = resolveTelemetryIdentity();
      this.attribution = resolveAttribution();
      this.events = this.loadQueue(this.identity.sessionId);
      this.debugEvents = this.loadDebugHistory(this.identity.sessionId);
      this.completionTracked = window.sessionStorage.getItem(COMPLETION_STORAGE_KEY) === 'true';
      this.currentStep = currentStep;
      this.initialized = true;
      this.exposeDebug();
      this.attachLifecycleSignals();

      if (this.identity.isNewSession) {
        this.emit('session_started', currentStep, { is_new_session: true });
      } else {
        this.emit('funnel_resumed', currentStep, { resumed_step: currentStep });
      }
      this.scheduleDelivery(0);
    } catch {
      // Telemetry is non-blocking. The funnel remains usable if storage is unavailable.
    }
  }

  stepViewed(step: StepId) {
    if (!this.initialized || this.currentStep === step && this.stepStartedAt.has(step)) return;
    this.currentStep = step;
    this.completedCurrentView = false;
    this.phoneCapturedCurrentView = false;
    this.stepStartedAt.set(step, performance.now());
    this.emit('step_viewed', step, {});
  }

  answerSelected(question: 'guests', value: GuestAnswerValue): void;
  answerSelected(question: 'service', value: ServiceAnswerValue): void;
  answerSelected(question: 'event_type', value: EventTypeAnswerValue): void;
  answerSelected(question: 'date', value: DateAnswerValue): void;
  answerSelected(question: keyof typeof ANSWER_VALUES, value: string) {
    if (!ANSWER_VALUES[question].has(value as never)) return;
    this.emit('answer_selected', this.currentStep, { question, value } as AnswerSelectedProperties);
  }

  stepCompleted(step: StepId, properties: StepCompletedProperties = {}): boolean {
    if (!this.initialized || this.completedCurrentView || step !== this.currentStep) return false;
    this.completedCurrentView = true;
    const startedAt = this.stepStartedAt.get(step);
    const duration = startedAt === undefined ? null : roundedMilliseconds(performance.now() - startedAt);
    this.stepStartedAt.delete(step);
    const safeProperties: StepCompletedProperties = step === 'zip'
      ? {
          zip_valid: properties.zip_valid === true,
          geo_resolved: properties.geo_resolved === true,
          ...(typeof properties.state === 'string' && /^[A-Z]{2}$/.test(properties.state)
            ? { state: properties.state }
            : {}),
        }
      : {};
    this.emit('step_completed', step, safeProperties, duration);
    return true;
  }

  backClicked(fromStep: StepId, toStep: StepId) {
    this.emit('back_clicked', fromStep, { from_step: fromStep, to_step: toStep });
  }

  validationError(step: StepId, code: ValidationCode) {
    this.emit('validation_error', step, { code });
  }

  phoneCaptured() {
    if (this.currentStep !== 'phone' || this.phoneCapturedCurrentView) return;
    this.phoneCapturedCurrentView = true;
    this.emit('phone_captured', 'phone', { valid: true, digit_count: 10 });
  }

  formCompleted() {
    if (this.completionTracked) return;
    this.completionTracked = true;
    try {
      window.sessionStorage.setItem(COMPLETION_STORAGE_KEY, 'true');
    } catch {
      // The in-memory guard still prevents duplicate completion events.
    }
    this.emit('form_completed', 'complete', { completed_step_count: 7 });
  }

  getLeadContext(): TelemetryLeadContext | null {
    if (!this.identity || !this.attribution) return null;
    return clone({
      visitor_id: this.identity.visitorId,
      session_id: this.identity.sessionId,
      attribution: this.attribution,
    });
  }

  startNewFunnel() {
    this.completionTracked = false;
    this.completedCurrentView = false;
    this.phoneCapturedCurrentView = false;
    this.stepStartedAt.clear();
    try {
      window.sessionStorage.removeItem(COMPLETION_STORAGE_KEY);
    } catch {
      // Ignore unavailable browser storage.
    }
  }

  private emit<Name extends TelemetryEventName>(
    eventName: Name,
    step: StepId,
    properties: TelemetryEventProperties[Name],
    stepDurationMs: number | null = null,
  ) {
    if (!this.identity || !this.attribution) return;

    const event = {
      schema_version: TELEMETRY_SCHEMA_VERSION,
      event_id: crypto.randomUUID(),
      event_name: eventName,
      occurred_at: new Date().toISOString(),
      visitor_id: this.identity.visitorId,
      session_id: this.identity.sessionId,
      intent_cluster: 'bbq',
      route: window.location.pathname.slice(0, 300),
      step_id: step,
      step_index: STEP_INDEX[step],
      properties,
      experiment_id: null,
      variant_id: null,
      step_duration_ms: stepDurationMs,
      session_elapsed_ms: roundedMilliseconds(Date.now() - this.identity.sessionStartedAt),
      attribution: this.attribution,
    } as GourmetTelemetryEvent;

    this.events = [...this.events, event].slice(-QUEUE_LIMIT);
    this.debugEvents = [...this.debugEvents, event].slice(-QUEUE_LIMIT);
    this.persistQueue();
    this.persistDebugHistory();
    this.scheduleDelivery();
  }

  private loadQueue(sessionId: string): GourmetTelemetryEvent[] {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(QUEUE_STORAGE_KEY) ?? '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is GourmetTelemetryEvent => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Partial<GourmetTelemetryEvent>;
        return candidate.schema_version === TELEMETRY_SCHEMA_VERSION
          && candidate.session_id === sessionId
          && typeof candidate.event_id === 'string'
          && EVENT_NAMES.has(candidate.event_name as TelemetryEventName);
      }).slice(-QUEUE_LIMIT);
    } catch {
      return [];
    }
  }

  private persistQueue() {
    try {
      window.sessionStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(this.events));
    } catch {
      // The in-memory queue remains primary if session storage is unavailable.
    }
  }

  private loadDebugHistory(sessionId: string): GourmetTelemetryEvent[] {
    try {
      const parsed = JSON.parse(window.sessionStorage.getItem(DEBUG_HISTORY_STORAGE_KEY) ?? '[]') as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is GourmetTelemetryEvent => {
        if (!item || typeof item !== 'object') return false;
        const candidate = item as Partial<GourmetTelemetryEvent>;
        return candidate.schema_version === TELEMETRY_SCHEMA_VERSION
          && candidate.session_id === sessionId
          && typeof candidate.event_id === 'string'
          && EVENT_NAMES.has(candidate.event_name as TelemetryEventName);
      }).slice(-QUEUE_LIMIT);
    } catch {
      return [];
    }
  }

  private persistDebugHistory() {
    try {
      window.sessionStorage.setItem(DEBUG_HISTORY_STORAGE_KEY, JSON.stringify(this.debugEvents));
    } catch {
      // Debug history is optional and never blocks the funnel or delivery queue.
    }
  }

  private attachLifecycleSignals() {
    document.addEventListener('visibilitychange', () => {
      const state = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
      if (state === this.lastVisibility) return;
      this.lastVisibility = state;
      this.emit('visibility_changed', this.currentStep, { state });
    });

    window.addEventListener('pagehide', () => {
      if (this.pagehideTracked) return;
      this.pagehideTracked = true;
      this.emit('page_exit_signal', this.currentStep, {
        reason: 'pagehide',
        last_step: this.currentStep,
      });
      transport.beacon(this.events.slice(0, DELIVERY_BATCH_SIZE));
    });

    window.addEventListener('pageshow', () => {
      this.pagehideTracked = false;
    });
  }

  private scheduleDelivery(delay = 500) {
    if (!transport.configured || this.events.length === 0 || this.deliveryInFlight || this.deliveryTimer !== null) return;
    if (this.deliveryRetry >= MAX_DELIVERY_RETRIES) this.deliveryRetry = 0;
    this.deliveryTimer = window.setTimeout(() => {
      this.deliveryTimer = null;
      void this.flushDelivery();
    }, delay);
  }

  private async flushDelivery() {
    if (!transport.configured || this.deliveryInFlight || this.events.length === 0) return;
    this.deliveryInFlight = true;
    try {
      const result = await deliverTelemetryBatch(this.events, transport, DELIVERY_BATCH_SIZE);
      this.events = result.remainingEvents;
      this.persistQueue();
      this.deliveryRetry = 0;
    } catch {
      this.deliveryRetry += 1;
    } finally {
      this.deliveryInFlight = false;
    }

    if (this.events.length === 0) return;
    if (this.deliveryRetry < MAX_DELIVERY_RETRIES) {
      const delay = Math.min(15_000, 750 * 2 ** this.deliveryRetry);
      this.scheduleDelivery(delay);
    }
  }

  private snapshot(): TelemetryDebugSnapshot {
    if (!this.identity || !this.attribution) {
      throw new Error('Telemetry has not initialized.');
    }
    return clone({
      visitor_id: this.identity.visitorId,
      session_id: this.identity.sessionId,
      attribution: this.attribution,
      events: this.debugEvents,
    });
  }

  private exposeDebug() {
    if (!window.location.pathname.startsWith('/form2/')) return;
    window.__GOURMET_TELEMETRY_DEBUG__ = {
      getSnapshot: () => this.snapshot(),
      getEvents: () => this.snapshot().events,
      getPendingEvents: () => clone(this.events),
    };
  }
}

export const telemetry = new GourmetTelemetry();
