import { FormEvent, useEffect, useMemo, useState } from 'react';
import { leadClient } from './api/lead-client';
import { telemetry } from './telemetry/telemetry';
import {
  AnswerValue,
  DateAnswerValue,
  EventTypeAnswerValue,
  GuestAnswerValue,
  ServiceAnswerValue,
  StepId,
  ValidationCode,
} from './telemetry/types';

type Answers = {
  guests?: string;
  service?: string;
  zip?: string;
  city?: string;
  state?: string;
  phone?: string;
  eventType?: string;
  dateWindow?: string;
  exactDate?: string;
  name?: string;
};

type SavedState = {
  version: 2;
  updatedAt: number;
  stepIndex: number;
  answers: Answers;
};

type Option<Value extends AnswerValue = AnswerValue> = {
  value: Value;
  title: string;
  subtitle?: string;
  icon?: 'people';
};

const LEGACY_STORAGE_KEY = 'gourmet_growth_v2_bbq_v1';
const SESSION_STORAGE_KEY = 'gourmet_growth_v2_bbq_session_v2';
const NON_PII_STORAGE_KEY = 'gourmet_growth_v2_bbq_non_pii_v2';
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
const TOTAL_STEPS = 7;
const TELEMETRY_STEPS: readonly StepId[] = [
  'guests',
  'service',
  'zip',
  'phone',
  'event_type',
  'date',
  'name',
  'complete',
];

const VALIDATION_CODES: Record<Exclude<StepId, 'complete'>, ValidationCode> = {
  guests: 'guests_required',
  service: 'service_required',
  zip: 'zip_invalid',
  phone: 'phone_invalid',
  event_type: 'event_type_required',
  date: 'date_required',
  name: 'name_required',
};

const guestOptions: Option<GuestAnswerValue>[] = [
  { value: '10-25', title: '10–25', subtitle: 'Guests' },
  { value: '26-50', title: '26–50', subtitle: 'Guests' },
  { value: '51-100', title: '51–100', subtitle: 'Guests' },
  { value: '101-200', title: '101–200', subtitle: 'Guests' },
  { value: '201+', title: '201+', subtitle: 'Guests' },
  { value: 'not-sure', title: 'Not sure yet', icon: 'people' },
];

const serviceOptions: Option<ServiceAnswerValue>[] = [
  { value: 'full-service', title: 'Full Service', subtitle: 'Setup, serving & cleanup' },
  { value: 'buffet', title: 'Buffet Setup', subtitle: 'Set up and ready to enjoy' },
  { value: 'drop-off', title: 'Drop-off & Go', subtitle: 'Delivered and ready' },
  { value: 'not-sure', title: 'Not sure yet', subtitle: 'We’ll help you choose' },
];

const eventOptions: Option<EventTypeAnswerValue>[] = [
  { value: 'Wedding', title: 'Wedding' },
  { value: 'Birthday', title: 'Birthday' },
  { value: 'Corporate', title: 'Corporate' },
  { value: 'Graduation', title: 'Graduation' },
  { value: 'Memorial / Funeral', title: 'Memorial / Funeral' },
  { value: 'Other', title: 'Other' },
];

const dateOptions: Option<DateAnswerValue>[] = [
  { value: 'exact', title: 'Exact date', subtitle: 'I know the date' },
  { value: 'next-2-weeks', title: 'Next 2 weeks', subtitle: 'Soon' },
  { value: 'this-month', title: 'This month', subtitle: 'Within 30 days' },
  { value: '1-3-months', title: '1–3 months', subtitle: 'Planning ahead' },
  { value: 'still-deciding', title: 'Still deciding', subtitle: 'Not sure yet' },
];

function loadSavedState(previewGolden: boolean): SavedState {
  try {
    window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);

    const sessionRaw = window.sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (sessionRaw) {
      const parsed = JSON.parse(sessionRaw) as SavedState;
      const fresh = parsed.version === 2 && Date.now() - parsed.updatedAt < STORAGE_TTL_MS;
      if (fresh) return parsed;
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
    }

    const raw = window.localStorage.getItem(NON_PII_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedState;
      const fresh = parsed.version === 2 && Date.now() - parsed.updatedAt < STORAGE_TTL_MS;
      if (fresh) return parsed;
      window.localStorage.removeItem(NON_PII_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private browsing modes. The funnel still works.
  }

  return {
    version: 2,
    updatedAt: Date.now(),
    stepIndex: 0,
    answers: previewGolden ? { guests: '10-25' } : {},
  };
}

function digitsOnly(value: string) {
  return value.replace(/\D+/g, '');
}

function normalizedPhoneDigits(value: string) {
  const digits = digitsOnly(value);
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.slice(0, 10);
}

function formatPhone(value: string) {
  const digits = normalizedPhoneDigits(value);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function todayIsoDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function FlameIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M13.7 2.7c.5 3-1 4.5-2.1 5.8-1.2 1.4-2.1 2.5-1.4 4.4.4-1.1 1.1-1.9 2.2-2.8-.1 2.6 2.1 3.5 2.1 6.2 0 2-1.2 3.6-3.1 4.2-3.7 1.2-7.4-1.6-7.4-5.4 0-3.1 1.8-5 3.7-7.1.1 2 .8 3.2 1.6 4-.5-3.7 2.3-5.1 4.4-9.3Z"
        fill="currentColor"
      />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function LeafIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19.5 4.5C12 4.8 6.1 8 5 14.4c-.4 2.6 1.2 4.6 3.8 4.6 6 0 9.3-6.4 10.7-14.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M5.5 19c2.3-4.2 5.3-6.8 9.2-8.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 19v-1.2c0-2.5 2.2-4.3 5-4.3s5 1.8 5 4.3V19m0-4.2c.7-.5 1.6-.8 2.6-.8 2.5 0 4.4 1.5 4.4 3.6V19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 7.5V12l3.2 2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6.5" y="10" width="11" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9 10V7.5a3 3 0 0 1 6 0V10" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OptionCard<Value extends AnswerValue>({
  option,
  selected,
  name,
  onSelect,
}: {
  option: Option<Value>;
  selected: boolean;
  name: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={`guest-option${selected ? ' is-selected' : ''}`}
      data-option-value={option.value}
    >
      <input
        type="radio"
        name={name}
        value={option.value}
        checked={selected}
        onChange={onSelect}
      />
      {option.icon && <span className="guest-option-icon"><PeopleIcon /></span>}
      <span className="guest-option-copy">
        <strong>{option.title}</strong>
        {option.subtitle && <small>{option.subtitle}</small>}
      </span>
    </label>
  );
}

function ProgressHeader({
  stepIndex,
  onBack,
}: {
  stepIndex: number;
  onBack: () => void;
}) {
  const stepNumber = Math.min(stepIndex + 1, TOTAL_STEPS);
  return (
    <>
      {stepIndex > 0 && (
        <button type="button" className="back-button" onClick={onBack}>
          <span aria-hidden="true">←</span> Back
        </button>
      )}
      <div className="progress-row">
        <div className="progress-left">
          <strong>Step {stepNumber} of {TOTAL_STEPS}</strong>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Quote progress"
            aria-valuemin={1}
            aria-valuemax={TOTAL_STEPS}
            aria-valuenow={stepNumber}
          >
            <span style={{ width: `${(stepNumber / TOTAL_STEPS) * 100}%` }} />
          </div>
        </div>
        <div className="event-time">
          <ClockIcon />
          <span><strong>Your Event</strong><small>1–2 min</small></span>
        </div>
      </div>
    </>
  );
}

function BBQFunnel() {
  const goldenPreview = useMemo(
    () => new URLSearchParams(window.location.search).get('preview') === 'golden',
    [],
  );
  const initial = useMemo(() => loadSavedState(goldenPreview), [goldenPreview]);

  const [stepIndex, setStepIndex] = useState(initial.stepIndex);
  const [answers, setAnswers] = useState<Answers>(initial.answers);
  const knownEventValues = useMemo(() => new Set<string>(eventOptions.map((option) => option.value)), []);
  const [eventOther, setEventOther] = useState(
    initial.answers.eventType && !knownEventValues.has(initial.answers.eventType)
      ? initial.answers.eventType
      : '',
  );
  const [zipLookup, setZipLookup] = useState<'idle' | 'loading' | 'found' | 'unknown'>(
    initial.answers.city ? 'found' : 'idle',
  );
  const [announcement, setAnnouncement] = useState('');
  const [deliveryError, setDeliveryError] = useState('');
  const [isSavingLead, setIsSavingLead] = useState(false);
  const step = TELEMETRY_STEPS[stepIndex] ?? 'complete';
  const initialStep = TELEMETRY_STEPS[initial.stepIndex] ?? 'guests';
  const isComplete = step === 'complete';

  useEffect(() => {
    document.title = 'BBQ Catering in Portland | Gourmet Corp';
  }, []);

  useEffect(() => {
    telemetry.initialize(initialStep);
  }, [initialStep]);

  useEffect(() => {
    telemetry.stepViewed(step);
    if (step === 'complete') telemetry.formCompleted();
  }, [step]);

  useEffect(() => {
    const fullSaved: SavedState = {
      version: 2,
      updatedAt: Date.now(),
      stepIndex,
      answers,
    };

    const durableAnswers: Answers = {
      guests: answers.guests,
      service: answers.service,
      zip: answers.zip,
      city: answers.city,
      state: answers.state,
      eventType: answers.eventType,
      dateWindow: answers.dateWindow,
      exactDate: answers.exactDate,
    };

    const durableSaved: SavedState = {
      version: 2,
      updatedAt: Date.now(),
      stepIndex: Math.min(stepIndex, 3),
      answers: durableAnswers,
    };

    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(fullSaved));
      window.localStorage.setItem(NON_PII_STORAGE_KEY, JSON.stringify(durableSaved));
    } catch {
      // Ignore storage failures; do not block the funnel.
    }
  }, [answers, stepIndex]);

  useEffect(() => {
    if (stepIndex === TOTAL_STEPS) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [stepIndex]);

  function updateAnswer(key: keyof Answers, value: string) {
    setAnswers((current) => ({ ...current, [key]: value }));
  }

  function next() {
    setStepIndex((current) => Math.min(current + 1, TOTAL_STEPS));
  }

  function back() {
    const targetStep = TELEMETRY_STEPS[Math.max(stepIndex - 1, 0)] ?? 'guests';
    telemetry.backClicked(step, targetStep);
    setStepIndex((current) => Math.max(current - 1, 0));
  }

  async function advanceIfValid(
    valid: boolean,
    message?: string,
    leadUpdates?: {
      event_type?: string;
      date_window?: string;
      exact_date?: string | null;
      first_name?: string;
    },
  ) {
    if (!valid) {
      if (message) setAnnouncement(message);
      if (step !== 'complete') telemetry.validationError(step, VALIDATION_CODES[step]);
      return false;
    }

    if (isSavingLead) return false;
    setDeliveryError('');

    if (step === 'phone') telemetry.phoneCaptured();
    if (leadClient.isConfigured && (step === 'phone' || leadUpdates)) {
      const context = telemetry.getLeadContext();
      if (!context) {
        const errorMessage = 'We could not securely save your request. Please try again.';
        setAnnouncement(errorMessage);
        setDeliveryError(errorMessage);
        return false;
      }

      setIsSavingLead(true);
      try {
        if (step === 'phone') {
          await leadClient.capturePhone(context, normalizedPhoneDigits(answers.phone || ''), {
            guest_range: answers.guests,
            service_style: answers.service,
            zip_code: answers.zip,
          });
        } else if (leadUpdates) {
          const leadId = leadClient.getLeadId();
          if (!leadId) throw new Error('missing_lead_id');
          await leadClient.update(leadId, context.session_id, leadUpdates);
        }
      } catch {
        const errorMessage = 'We could not securely save your request. Check your connection and try again.';
        setAnnouncement(errorMessage);
        setDeliveryError(errorMessage);
        return false;
      } finally {
        setIsSavingLead(false);
      }
    }

    const completed = telemetry.stepCompleted(
      step,
      step === 'zip'
        ? {
            zip_valid: /^\d{5}$/.test(answers.zip || ''),
            geo_resolved: zipLookup === 'found',
            state: answers.state,
          }
        : {},
    );
    if (!completed) return false;

    setAnnouncement('');
    setDeliveryError('');
    next();
    return true;
  }

  function continueWith(
    event: FormEvent,
    valid: boolean,
    message?: string,
    leadUpdates?: Parameters<typeof advanceIfValid>[2],
  ) {
    event.preventDefault();
    void advanceIfValid(valid, message, leadUpdates);
  }

  async function resolveZip(zip: string) {
    if (!/^\d{5}$/.test(zip)) {
      setZipLookup('idle');
      setAnswers((current) => ({ ...current, city: undefined, state: undefined }));
      return;
    }

    setZipLookup('loading');

    try {
      const group = zip.slice(0, 3);
      const response = await fetch(`/bbq/cities/group-${group}.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error('ZIP lookup unavailable');

      const data = await response.json();
      const row = data?.[zip];
      if (row?.City || row?.ST) {
        setAnswers((current) => ({
          ...current,
          city: row.City || '',
          state: row.ST || '',
        }));
        setZipLookup('found');
      } else {
        setAnswers((current) => ({ ...current, city: undefined, state: undefined }));
        setZipLookup('unknown');
      }
    } catch {
      setAnswers((current) => ({ ...current, city: undefined, state: undefined }));
      setZipLookup('unknown');
    }
  }

  function handleZip(value: string) {
    const zip = digitsOnly(value).slice(0, 5);
    updateAnswer('zip', zip);
    void resolveZip(zip);
  }

  function handlePhone(value: string) {
    updateAnswer('phone', formatPhone(value));
  }

  function resetFunnel() {
    try {
      window.localStorage.removeItem(NON_PII_STORAGE_KEY);
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      window.sessionStorage.removeItem(SESSION_STORAGE_KEY);
      window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
    setAnswers({});
    setEventOther('');
    setZipLookup('idle');
    setAnnouncement('');
    setDeliveryError('');
    setIsSavingLead(false);
    leadClient.reset();
    telemetry.startNewFunnel();
    setStepIndex(0);
  }

  const currentEventType = answers.eventType
    ? (knownEventValues.has(answers.eventType) ? answers.eventType : 'Other')
    : (eventOther ? 'Other' : '');

  const dateValid = answers.dateWindow
    ? answers.dateWindow !== 'exact' || Boolean(answers.exactDate)
    : false;

  return (
    <main className="mobile-stage">
      <div className={`mobile-app${stepIndex > 0 ? ' has-progressed' : ''}`}>
        <header className="brand-header">
          <div className="brand-lockup" aria-label="Gourmet Corp">
            <span className="brand-mark"><FlameIcon /></span>
            <span className="brand-words">
              <strong>GOURMET CORP</strong>
              <small>FOOD BRINGS PEOPLE TOGETHER</small>
            </span>
          </div>
          <span className="menu-button" aria-hidden="true"><MenuIcon /></span>
        </header>

        <section className="bbq-hero" aria-labelledby="bbq-title">
          <div className="hero-content">
            <p className="hero-eyebrow">BBQ CATERING · PORTLAND</p>
            <h1 id="bbq-title">BBQ Catering<br />in Portland</h1>
            <p className="hero-copy">
              Amazing food. Unforgettable events. Get a personalized quote in under 2 minutes.
            </p>
            <div className="hero-features" aria-label="Service highlights">
              <span><i><LeafIcon /></i>Local<br />team</span>
              <span><i><PeopleIcon /></i>Events of<br />any size</span>
              <span><i><StarIcon /></i>Custom<br />menus</span>
            </div>
          </div>
        </section>

        <section className={`quote-panel${isComplete ? ' completion-shell' : ''}`}>
          {!isComplete && <ProgressHeader stepIndex={stepIndex} onBack={back} />}

          {step === 'guests' && (
            <form onSubmit={(event) => continueWith(event, Boolean(answers.guests), 'Choose a guest range to continue.')}>
              <fieldset>
                <legend>How many guests are you catering for?</legend>
                <p className="question-help">A quick estimate is perfect.</p>
                <div className="guest-grid">
                  {guestOptions.map((option) => (
                    <OptionCard
                      key={option.value}
                      option={option}
                      selected={answers.guests === option.value}
                      name="guest-count"
                      onSelect={() => {
                        updateAnswer('guests', option.value);
                        telemetry.answerSelected('guests', option.value);
                      }}
                    />
                  ))}
                </div>
              </fieldset>

              <div className="local-proof" aria-label="Local service information">
                <span className="proof-icon"><PeopleIcon /></span>
                <span className="proof-copy">
                  <strong>Serving Portland-area events</strong>
                  <small>Check availability in under 2 minutes</small>
                </span>
                <span className="proof-chevron">›</span>
              </div>

              <button
                className="continue-button"
                type="button"
                disabled={!answers.guests}
                onClick={() => void advanceIfValid(Boolean(answers.guests), 'Choose a guest range to continue.')}
              >
                <span>Continue</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'service' && (
            <form onSubmit={(event) => continueWith(event, Boolean(answers.service), 'Choose a service style to continue.')}>
              <fieldset>
                <legend>How would you like it served?</legend>
                <p className="question-help">You can change this later if plans evolve.</p>
                <div className="guest-grid is-two">
                  {serviceOptions.map((option) => (
                    <OptionCard
                      key={option.value}
                      option={option}
                      selected={answers.service === option.value}
                      name="service-style"
                      onSelect={() => {
                        updateAnswer('service', option.value);
                        telemetry.answerSelected('service', option.value);
                      }}
                    />
                  ))}
                </div>
              </fieldset>

              <div className="step-spacer" />
              <button
                className="continue-button"
                type="button"
                disabled={!answers.service}
                onClick={() => void advanceIfValid(Boolean(answers.service), 'Choose a service style to continue.')}
              >
                <span>Continue</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'zip' && (
            <form onSubmit={(event) => continueWith(event, /^\d{5}$/.test(answers.zip || ''), 'Enter a 5-digit ZIP code.')}>
              <fieldset>
                <legend>Where is your event?</legend>
                <p className="question-help">Enter the event ZIP code so we can localize the quote.</p>

                <label className="field-label" htmlFor="event-zip">Event ZIP code</label>
                <input
                  id="event-zip"
                  className="text-input"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  maxLength={5}
                  value={answers.zip || ''}
                  onChange={(event) => handleZip(event.target.value)}
                  placeholder="97205"
                  aria-describedby="zip-status"
                />

                <div id="zip-status" className={`field-status ${zipLookup}`} aria-live="polite">
                  {zipLookup === 'loading' && 'Checking ZIP…'}
                  {zipLookup === 'found' && `✓ ZIP recognized: ${answers.city || ''}${answers.city && answers.state ? ', ' : ''}${answers.state || ''}`}
                  {zipLookup === 'unknown' && /^\d{5}$/.test(answers.zip || '') && 'We’ll confirm service availability for this ZIP with your quote.'}
                </div>
              </fieldset>

              <div className="step-spacer" />
              <button
                className="continue-button"
                type="button"
                disabled={!/^\d{5}$/.test(answers.zip || '')}
                onClick={() => void advanceIfValid(/^\d{5}$/.test(answers.zip || ''), 'Enter a 5-digit ZIP code.')}
              >
                <span>Continue</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'phone' && (
            <form
              onSubmit={(event) => continueWith(
                event,
                normalizedPhoneDigits(answers.phone || '').length === 10,
                'Enter a valid 10-digit phone number.',
              )}
            >
              <fieldset>
                <legend>What’s the best phone number to reach you?</legend>
                <p className="question-help">We’ll only use it for this catering request. No spam.</p>

                <label className="field-label" htmlFor="phone">Mobile number</label>
                <input
                  id="phone"
                  className="text-input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={answers.phone || ''}
                  onChange={(event) => handlePhone(event.target.value)}
                  placeholder="(503) 555-0123"
                  aria-describedby="phone-note"
                />
                <p id="phone-note" className="trust-line"><LockIcon />Your information stays private.</p>
              </fieldset>

              <div className="step-spacer compact" />
              <button
                className="continue-button"
                type="button"
                disabled={normalizedPhoneDigits(answers.phone || '').length !== 10 || isSavingLead}
                onClick={() => void advanceIfValid(
                  normalizedPhoneDigits(answers.phone || '').length === 10,
                  'Enter a valid 10-digit phone number.',
                )}
              >
                <span>{isSavingLead ? 'Saving securely…' : 'Continue'}</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'event_type' && (
            <form
              onSubmit={(event) => {
                const valid = currentEventType && (currentEventType !== 'Other' || eventOther.trim().length >= 2);
                if (valid && currentEventType === 'Other') {
                  updateAnswer('eventType', eventOther.trim());
                }
                continueWith(
                  event,
                  Boolean(valid),
                  'Choose or describe your event type.',
                  valid ? { event_type: currentEventType === 'Other' ? eventOther.trim() : currentEventType } : undefined,
                );
              }}
            >
              <fieldset>
                <legend>What kind of event is it?</legend>
                <p className="question-help">BBQ is your catering style; this tells us the occasion.</p>

                <div className="guest-grid is-two">
                  {eventOptions.map((option) => (
                    <OptionCard
                      key={option.value}
                      option={option}
                      selected={currentEventType === option.value}
                      name="event-type"
                      onSelect={() => {
                        telemetry.answerSelected('event_type', option.value);
                        if (option.value === 'Other') {
                          updateAnswer('eventType', 'Other');
                        } else {
                          setEventOther('');
                          updateAnswer('eventType', option.value);
                        }
                      }}
                    />
                  ))}
                </div>

                {currentEventType === 'Other' && (
                  <div className="conditional-field">
                    <label className="field-label" htmlFor="event-other">Describe your event</label>
                    <input
                      id="event-other"
                      className="text-input"
                      value={eventOther}
                      onChange={(event) => setEventOther(event.target.value)}
                      placeholder="e.g. Communion, anniversary…"
                      autoComplete="off"
                    />
                  </div>
                )}
              </fieldset>

              <div className="step-spacer compact" />
              <button
                className="continue-button"
                type="button"
                disabled={!currentEventType || (currentEventType === 'Other' && eventOther.trim().length < 2) || isSavingLead}
                onClick={() => {
                  const valid = Boolean(currentEventType) && (currentEventType !== 'Other' || eventOther.trim().length >= 2);
                  if (valid && currentEventType === 'Other') {
                    updateAnswer('eventType', eventOther.trim());
                  }
                  void advanceIfValid(
                    valid,
                    'Choose or describe your event type.',
                    valid ? { event_type: currentEventType === 'Other' ? eventOther.trim() : currentEventType } : undefined,
                  );
                }}
              >
                <span>{isSavingLead ? 'Saving securely…' : 'Continue'}</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'date' && (
            <form onSubmit={(event) => continueWith(
              event,
              dateValid,
              'Choose a timing option to continue.',
              dateValid ? {
                date_window: answers.dateWindow,
                exact_date: answers.dateWindow === 'exact' ? answers.exactDate : null,
              } : undefined,
            )}>
              <fieldset>
                <legend>When is your event?</legend>
                <p className="question-help">An exact date is optional. A rough window is enough.</p>

                <div className="guest-grid is-two date-grid">
                  {dateOptions.map((option) => (
                    <OptionCard
                      key={option.value}
                      option={option}
                      selected={answers.dateWindow === option.value}
                      name="date-window"
                      onSelect={() => {
                        updateAnswer('dateWindow', option.value);
                        telemetry.answerSelected('date', option.value);
                      }}
                    />
                  ))}
                </div>

                {answers.dateWindow === 'exact' && (
                  <div className="conditional-field">
                    <label className="field-label" htmlFor="exact-date">Event date</label>
                    <input
                      id="exact-date"
                      className="text-input"
                      type="date"
                      min={todayIsoDate()}
                      value={answers.exactDate || ''}
                      onChange={(event) => updateAnswer('exactDate', event.target.value)}
                    />
                  </div>
                )}

                <div className="local-proof compact-proof">
                  <span className="proof-icon"><ClockIcon /></span>
                  <span className="proof-copy">
                    <strong>Not sure yet? That’s okay.</strong>
                    <small>You can narrow the date down later.</small>
                  </span>
                </div>
              </fieldset>

              <button
                className="continue-button"
                type="button"
                disabled={!dateValid || isSavingLead}
                onClick={() => void advanceIfValid(
                  dateValid,
                  'Choose a timing option to continue.',
                  dateValid ? {
                    date_window: answers.dateWindow,
                    exact_date: answers.dateWindow === 'exact' ? answers.exactDate : null,
                  } : undefined,
                )}
              >
                <span>{isSavingLead ? 'Saving securely…' : 'Continue'}</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'name' && (
            <form
              onSubmit={(event) => continueWith(
                event,
                (answers.name || '').trim().length >= 2,
                'Enter your first name.',
                (answers.name || '').trim().length >= 2
                  ? { first_name: (answers.name || '').trim() }
                  : undefined,
              )}
            >
              <fieldset>
                <legend>Last step — what’s your first name?</legend>
                <p className="question-help">So we can personalize your catering quote.</p>

                <label className="field-label" htmlFor="first-name">First name</label>
                <input
                  id="first-name"
                  className="text-input"
                  autoComplete="given-name"
                  value={answers.name || ''}
                  onChange={(event) => updateAnswer('name', event.target.value)}
                  placeholder="First name"
                />
              </fieldset>

              <div className="step-spacer" />
              <button
                className="continue-button"
                type="button"
                disabled={(answers.name || '').trim().length < 2 || isSavingLead}
                onClick={() => void advanceIfValid(
                  (answers.name || '').trim().length >= 2,
                  'Enter your first name.',
                  (answers.name || '').trim().length >= 2
                    ? { first_name: (answers.name || '').trim() }
                    : undefined,
                )}
              >
                <span>{isSavingLead ? 'Saving securely…' : 'Finish'}</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'complete' && (
            <div className="completion-panel">
              <span className="completion-kicker">STAGING FLOW COMPLETE</span>
              <h2>Thanks{answers.name ? `, ${answers.name.trim()}` : ''}.</h2>
              <p>
                Your BBQ quote flow is complete. CRM delivery and external tracking are intentionally not connected yet.
              </p>

              <dl className="summary-list">
                <div><dt>Guests</dt><dd>{answers.guests || '—'}</dd></div>
                <div><dt>Service</dt><dd>{answers.service || '—'}</dd></div>
                <div><dt>ZIP</dt><dd>{answers.zip || '—'}{answers.city ? ` · ${answers.city}, ${answers.state}` : ''}</dd></div>
                <div><dt>Event</dt><dd>{answers.eventType || '—'}</dd></div>
                <div><dt>Timing</dt><dd>{answers.dateWindow === 'exact' ? answers.exactDate : answers.dateWindow || '—'}</dd></div>
              </dl>

              <button className="continue-button secondary-action" type="button" onClick={resetFunnel}>
                <span>Start a new quote</span>
              </button>
            </div>
          )}

          {!isComplete && (
            <>
              {deliveryError && <p className="delivery-error" role="alert">{deliveryError}</p>}
              <p className="privacy-note"><LockIcon />Your information is secure and never shared.</p>
              <p className="sr-only" aria-live="polite">{announcement}</p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function FoundationScreen() {
  return (
    <main className="shell">
      <section className="card" aria-labelledby="page-title">
        <p className="eyebrow">GOURMET CORPORATION</p>
        <h1 id="page-title">Growth Form V2</h1>
        <p className="lede">
          Mobile-first staging foundation is running. Open <code>/form2/bbq/</code> for the M0 funnel.
        </p>
        <div className="status">
          <span className="dot" aria-hidden="true" />
          Foundation ready
        </div>
      </section>
    </main>
  );
}

export default function App() {
  return window.location.pathname.includes('/bbq') ? <BBQFunnel /> : <FoundationScreen />;
}
