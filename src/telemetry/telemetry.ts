import { resolveAttribution } from './attribution';
import { resolveTelemetryIdentity, TelemetryIdentity } from './identity';
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
  TelemetryEventName,
  TelemetryEventProperties,
  ValidationCode,
} from './types';

const QUEUE_STORAGE_KEY = 'gourmet_growth_telemetry_queue_v1';
const QUEUE_LIMIT = 100;
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
  private currentStep: StepId = 'guests';
  private stepStartedAt = new Map<StepId, number>();
  private completedCurrentView = false;
  private completionTracked = false;
  private lastVisibility: 'hidden' | 'visible' | null = null;
  private pagehideTracked = false;

  initialize(currentStep: StepId) {
    if (this.initialized) return;

    try {
      this.identity = resolveTelemetryIdentity();
      this.attribution = resolveAttribution();
      this.events = this.loadQueue(this.identity.sessionId);
      this.completionTracked = this.events.some((event) => event.event_name === 'form_completed');
      this.currentStep = currentStep;
      this.initialized = true;
      this.exposeDebug();
      this.attachLifecycleSignals();

      if (this.identity.isNewSession) {
        this.emit('session_started', currentStep, { is_new_session: true });
      } else {
        this.emit('funnel_resumed', currentStep, { resumed_step: currentStep });
      }
    } catch {
      // Telemetry is non-blocking. The funnel remains usable if storage is unavailable.
    }
  }

  stepViewed(step: StepId) {
    if (!this.initialized || this.currentStep === step && this.stepStartedAt.has(step)) return;
    this.currentStep = step;
    this.completedCurrentView = false;
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
    this.emit('phone_captured', 'phone', { valid: true, digit_count: 10 });
  }

  formCompleted() {
    if (this.completionTracked) return;
    this.completionTracked = true;
    this.emit('form_completed', 'complete', { completed_step_count: 7 });
  }

  startNewFunnel() {
    this.completionTracked = false;
    this.completedCurrentView = false;
    this.stepStartedAt.clear();
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
    this.persistQueue();
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
    });

    window.addEventListener('pageshow', () => {
      this.pagehideTracked = false;
    });
  }

  private snapshot(): TelemetryDebugSnapshot {
    if (!this.identity || !this.attribution) {
      throw new Error('Telemetry has not initialized.');
    }
    return clone({
      visitor_id: this.identity.visitorId,
      session_id: this.identity.sessionId,
      attribution: this.attribution,
      events: this.events,
    });
  }

  private exposeDebug() {
    if (!window.location.pathname.startsWith('/form2/')) return;
    window.__GOURMET_TELEMETRY_DEBUG__ = {
      getSnapshot: () => this.snapshot(),
      getEvents: () => this.snapshot().events,
    };
  }
}

export const telemetry = new GourmetTelemetry();
