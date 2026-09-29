import { type CSSProperties, FormEvent, useEffect, useMemo, useState } from 'react';
import { leadClient } from './api/lead-client';
import { ConsentBanner } from './measurement/ConsentBanner';
import { measurement } from './measurement/measurement';
import { telemetry } from './telemetry/telemetry';
import { resolveExperimentContext } from './experiments/context';
import { buildThankYouRedirectUrl } from './variants/thank-you';
import { loadCompletionSnapshot, saveCompletionSnapshot } from './variants/completion-snapshot';
import { resolveVariant } from './variants/registry';
import type { FunnelVariant, VariantIcon } from './variants/types';
import {
  AnswerValue,
  DateAnswerValue,
  EventTypeAnswerValue,
  GuestAnswerValue,
  ServiceAnswerValue,
  STEP_INDEX,
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
  icon?: 'people' | 'calendar' | 'help';
};

const STORAGE_TTL_MS = 24 * 60 * 60 * 1000;
const CANONICAL_VISIBLE_STEPS: readonly Exclude<StepId, 'complete'>[] = [
  'guests',
  'service',
  'zip',
  'phone',
  'event_type',
  'date',
  'name',
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
  { value: 'exact', title: 'Exact date', subtitle: 'I know the date', icon: 'calendar' },
  { value: 'next-2-weeks', title: 'Next 2 weeks', subtitle: 'Soon', icon: 'calendar' },
  { value: 'this-month', title: 'This month', subtitle: 'Within 30 days', icon: 'calendar' },
  { value: '1-3-months', title: '1–3 months', subtitle: 'Planning ahead', icon: 'calendar' },
  { value: 'still-deciding', title: 'Still deciding', subtitle: 'Not sure yet', icon: 'help' },
];

function storageKeys(variantSlug: string) {
  return {
    legacy: `gourmet_growth_v2_${variantSlug}_v1`,
    session: `gourmet_growth_v2_${variantSlug}_session_v2`,
    nonPii: `gourmet_growth_v2_${variantSlug}_non_pii_v2`,
  };
}

function prefilledAnswers(variant: FunnelVariant): Answers {
  return variant.prefilledAnswers?.eventType ? { eventType: variant.prefilledAnswers.eventType } : {};
}

function loadSavedState(previewGolden: boolean, variant: FunnelVariant): SavedState {
  const keys = storageKeys(variant.slug);
  const fallbackAnswers: Answers = {
    ...prefilledAnswers(variant),
    ...(previewGolden ? { guests: '10-25' } : {}),
  };
  const normalize = (candidate: SavedState): SavedState => ({
    version: 2,
    updatedAt: candidate.updatedAt,
    stepIndex: Math.min(Math.max(candidate.stepIndex, 0), variant.visibleSteps.length),
    answers: { ...candidate.answers, ...prefilledAnswers(variant) },
  });
  try {
    window.sessionStorage.removeItem(keys.legacy);
    window.localStorage.removeItem(keys.legacy);

    const sessionRaw = window.sessionStorage.getItem(keys.session);
    if (sessionRaw) {
      const parsed = JSON.parse(sessionRaw) as SavedState;
      const fresh = parsed.version === 2 && Date.now() - parsed.updatedAt < STORAGE_TTL_MS;
      if (fresh) return normalize(parsed);
      window.sessionStorage.removeItem(keys.session);
    }

    const raw = window.localStorage.getItem(keys.nonPii);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedState;
      const fresh = parsed.version === 2 && Date.now() - parsed.updatedAt < STORAGE_TTL_MS;
      if (fresh) return normalize(parsed);
      window.localStorage.removeItem(keys.nonPii);
    }
  } catch {
    // Storage can be unavailable in private browsing modes. The funnel still works.
  }

  return {
    version: 2,
    updatedAt: Date.now(),
    stepIndex: 0,
    answers: fallbackAnswers,
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="m8 12 2.6 2.7L16.5 9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 21s6-5.1 6-11a6 6 0 1 0-12 0c0 5.9 6 11 6 11Z" fill="currentColor" />
      <circle cx="12" cy="10" r="2.2" fill="#fff" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="5.5" width="15" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 3.5v4M16 3.5v4M4.5 10h15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M8 14h.01M12 14h.01M16 14h.01" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M9.6 9.3a2.55 2.55 0 1 1 4.2 2c-.9.75-1.8 1.25-1.8 2.7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12 17.1h.01" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function TrustBadgeIcon({ icon }: { icon: VariantIcon }) {
  if (icon === 'leaf') return <LeafIcon />;
  if (icon === 'people') return <PeopleIcon />;
  return <StarIcon />;
}

function BrandHeader() {
  return (
    <header className="brand-header">
      <div className="brand-lockup" aria-label="Gourmet Corp">
        <span className="brand-mark"><FlameIcon /></span>
        <span className="brand-words">
          <strong>GOURMET CORP</strong>
          <small>FOOD BRINGS PEOPLE TOGETHER</small>
        </span>
      </div>
    </header>
  );
}

function SocialProofPreview() {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <aside className="social-proof-toast" aria-label="QA preview: service information">
      <span className="proof-icon"><PeopleIcon /></span>
      <span className="proof-copy">
        <strong>Serving Portland-area events</strong>
        <small>We’ll confirm details with your quote</small>
      </span>
      <button type="button" onClick={() => setVisible(false)} aria-label="Close preview">×</button>
    </aside>
  );
}

function ExitIntentPreview({ variant }: { variant: FunnelVariant }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <div className="exit-preview-backdrop" role="presentation">
      <section className="exit-preview" role="dialog" aria-modal="true" aria-labelledby="exit-preview-title">
        <button className="exit-preview-close" type="button" onClick={() => setVisible(false)} aria-label="Close preview">×</button>
        <span className="exit-preview-icon"><CheckIcon /></span>
        <p className="exit-preview-kicker">SAVE YOUR PROGRESS</p>
        <h2 id="exit-preview-title">{variant.exitIntent.headline}</h2>
        <p>{variant.exitIntent.supportingCopy}</p>
        <button className="continue-button" type="button" onClick={() => setVisible(false)}>
          <span>{variant.exitIntent.ctaLabel}</span><ArrowIcon />
        </button>
        <button className="exit-preview-later" type="button" onClick={() => setVisible(false)}>I’ll finish later</button>
      </section>
    </div>
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
      {option.icon && (
        <span className="guest-option-icon" aria-hidden="true">
          {option.icon === 'people' && <PeopleIcon />}
          {option.icon === 'calendar' && <CalendarIcon />}
          {option.icon === 'help' && <HelpIcon />}
        </span>
      )}
      <span className="guest-option-copy">
        <strong>{option.title}</strong>
        {option.subtitle && <small>{option.subtitle}</small>}
      </span>
    </label>
  );
}

function ProgressHeader({
  stepIndex,
  totalSteps,
  onBack,
  variant,
}: {
  stepIndex: number;
  totalSteps: number;
  onBack: () => void;
  variant: FunnelVariant;
}) {
  const stepNumber = Math.min(stepIndex + 1, totalSteps);
  return (
    <>
      {stepIndex > 0 && (
        <button type="button" className="back-button" onClick={onBack}>
          <span aria-hidden="true">←</span> Back
        </button>
      )}
      <div className="progress-row">
        <div className="progress-left">
          <strong>{variant.progress.stepLabel} {stepNumber} of {totalSteps}</strong>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Quote progress"
            aria-valuemin={1}
            aria-valuemax={totalSteps}
            aria-valuenow={stepNumber}
          >
            <span style={{ width: `${(stepNumber / totalSteps) * 100}%` }} />
          </div>
        </div>
        <div className="event-time">
          <ClockIcon />
          <span><strong>{variant.progress.shortLabel}</strong><small>{variant.progress.countLabel}</small></span>
        </div>
      </div>
    </>
  );
}

function VariantFunnel({ variant }: { variant: FunnelVariant }) {
  const previewMode = useMemo(() => new URLSearchParams(window.location.search).get('preview'), []);
  const goldenPreview = previewMode === 'golden';
  const initial = useMemo(
    () => loadSavedState(goldenPreview, variant),
    [goldenPreview, variant],
  );

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
  const visibleSteps = variant.visibleSteps;
  const step: StepId = stepIndex >= visibleSteps.length ? 'complete' : visibleSteps[stepIndex];
  const initialStep = visibleSteps[initial.stepIndex] ?? visibleSteps[0] ?? CANONICAL_VISIBLE_STEPS[0];
  const isComplete = step === 'complete';
  const showHero = step === 'guests' || step === 'zip' || step === 'date';
  const experimentContext = useMemo(() => resolveExperimentContext(variant.metadata), [variant.metadata]);
  const compactFirstScreen = experimentContext.assignment.experimentId === 'bbq-first-screen-density-v1'
    && experimentContext.assignment.variantId === 'compact-first-screen';

  useEffect(() => {
    document.title = variant.documentTitle;
  }, [variant.documentTitle]);

  useEffect(() => {
    telemetry.initialize(initialStep, variant.metadata, experimentContext);
    measurement.initialize(variant.metadata);
    measurement.formStart();
  }, [experimentContext, initialStep, variant.metadata]);

  useEffect(() => {
    telemetry.stepViewed(step);
    if (step === 'complete') {
      telemetry.formCompleted();
      measurement.formComplete();
    }
  }, [step]);

  useEffect(() => {
    const keys = storageKeys(variant.slug);
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
      window.sessionStorage.setItem(keys.session, JSON.stringify(fullSaved));
      window.localStorage.setItem(keys.nonPii, JSON.stringify(durableSaved));
    } catch {
      // Ignore storage failures; do not block the funnel.
    }
  }, [answers, stepIndex, variant.slug]);

  useEffect(() => {
    if (stepIndex === visibleSteps.length) return;
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }, [stepIndex]);

  function updateAnswer(key: keyof Answers, value: string) {
    setAnnouncement('');
    setDeliveryError('');
    setAnswers((current) => ({ ...current, [key]: value }));
  }

  function next() {
    setStepIndex((current) => Math.min(current + 1, visibleSteps.length));
  }

  function back() {
    const targetStep = visibleSteps[Math.max(stepIndex - 1, 0)] ?? visibleSteps[0] ?? 'guests';
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

    if (step === 'phone') {
      telemetry.phoneCaptured();
      measurement.phoneCapture();
    }
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
          const captured = await leadClient.capturePhone(context, normalizedPhoneDigits(answers.phone || ''), {
            guest_range: answers.guests,
            service_style: answers.service,
            zip_code: answers.zip,
            event_type: answers.eventType,
          }, measurement.getServerConsentEvidence(), variant.metadata);
          if (!captured) throw new Error('missing_captured_lead');
          measurement.generateLead(captured.conversionId);
        } else if (leadUpdates) {
          const leadId = leadClient.getLeadId(variant.metadata);
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

    measurement.stepComplete({
      step_id: step,
      step_index: STEP_INDEX[step],
      ...(step === 'guests' && answers.guests ? { guest_range: answers.guests } : {}),
      ...(step === 'service' && answers.service ? { service_style: answers.service } : {}),
      ...(step === 'zip' && /^[A-Z]{2}$/.test(answers.state || '') ? { geo_state: answers.state } : {}),
      ...(step === 'event_type' && currentEventType
        ? { event_type: knownEventValues.has(currentEventType) ? currentEventType : 'Other' }
        : {}),
      ...(step === 'date' && answers.dateWindow ? { date_window: answers.dateWindow } : {}),
    });

    if (step === 'name') {
      const context = telemetry.getLeadContext();
      const persistedLead = leadClient.getLeadId(variant.metadata);
      const redirectUrl = context
        ? buildThankYouRedirectUrl(variant, context.attribution, window.location.origin)
        : null;
      if (redirectUrl && leadClient.isConfigured && persistedLead) {
        saveCompletionSnapshot({
          variant: variant.slug,
          firstName: answers.name,
          eventType: answers.eventType,
          guests: answers.guests,
          service: answers.service,
          timing: answers.dateWindow === 'exact' ? answers.exactDate : answers.dateWindow,
        });
        telemetry.stepViewed('complete');
        telemetry.formCompleted();
        measurement.formComplete();
        window.location.assign(redirectUrl);
        return true;
      }
    }

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

    // No trustworthy V2-owned ZIP dataset is available yet. Keep a transparent,
    // non-blocking fallback instead of requesting the known-missing legacy file.
    setAnswers((current) => ({ ...current, city: undefined, state: undefined }));
    setZipLookup('unknown');
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
    const keys = storageKeys(variant.slug);
    try {
      window.localStorage.removeItem(keys.nonPii);
      window.localStorage.removeItem(keys.legacy);
      window.sessionStorage.removeItem(keys.session);
      window.sessionStorage.removeItem(keys.legacy);
    } catch {
      // Ignore storage failures.
    }
    setAnswers(prefilledAnswers(variant));
    setEventOther('');
    setZipLookup('idle');
    setAnnouncement('');
    setDeliveryError('');
    setIsSavingLead(false);
    leadClient.reset(variant.metadata);
    telemetry.startNewFunnel();
    measurement.startNewFunnel();
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
      <div className={`mobile-app${stepIndex > 0 ? ' has-progressed' : ''}${showHero ? ' show-hero' : ''}${compactFirstScreen ? ' experiment-compact-first-screen' : ''}`}>
        <BrandHeader />

        <section
          className={`bbq-hero variant-${variant.slug}${variant.hero.image.src ? ' has-hero-image' : ''}`}
          aria-labelledby="variant-title"
          {...(variant.hero.image.src
            ? {
                style: {
                  '--hero-image-mobile': `url(${variant.hero.image.mobileSrc ?? variant.hero.image.src})`,
                  '--hero-image-desktop': `url(${variant.hero.image.src})`,
                } as CSSProperties,
              }
            : {})}
        >
          <div className="hero-content">
            <p className="hero-eyebrow">{variant.hero.eyebrow}</p>
            <h1 id="variant-title">{variant.hero.headline[0]}{variant.hero.headline[1] && <><br />{variant.hero.headline[1]}</>}</h1>
            <p className="hero-copy">{variant.hero.subheadline}</p>
            <div className="hero-features" aria-label="Service highlights">
              {variant.trustBadges.map((badge) => (
                <span key={badge.lines.join('-')}>
                  <i><TrustBadgeIcon icon={badge.icon} /></i>{badge.lines[0]}<br />{badge.lines[1]}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section
          className={`quote-panel${isComplete ? ' completion-shell' : ''}`}
          data-clarity-mask="true"
        >
          {!isComplete && <ProgressHeader stepIndex={stepIndex} totalSteps={visibleSteps.length} onBack={back} variant={variant} />}

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
                  <strong>{variant.proofBar.headline}</strong>
                  <small>{variant.proofBar.supportingCopy}</small>
                </span>
                <span className="proof-chevron">›</span>
              </div>

              <button
                className="continue-button"
                type="button"
                disabled={!answers.guests}
                onClick={() => void advanceIfValid(Boolean(answers.guests), 'Choose a guest range to continue.')}
              >
                <span>{variant.cta.continue}</span><ArrowIcon />
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
                <span>{variant.cta.continue}</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'zip' && (
            <form onSubmit={(event) => continueWith(event, /^\d{5}$/.test(answers.zip || ''), 'Enter a 5-digit ZIP code.')}>
              <fieldset>
                <legend>Where is your event?</legend>
                <p className="question-help">Enter the event ZIP code so we can localize the quote.</p>

                <label className="field-label" htmlFor="event-zip">Event ZIP code</label>
                <div className="input-with-icon">
                  <span aria-hidden="true"><PinIcon /></span>
                  <input
                    id="event-zip"
                    className="text-input"
                    data-clarity-mask="true"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={5}
                    value={answers.zip || ''}
                    onChange={(event) => handleZip(event.target.value)}
                    placeholder="97205"
                    aria-describedby="zip-status"
                  />
                </div>

                <div id="zip-status" className={`field-status zip-status-card ${zipLookup}`} aria-live="polite">
                  {zipLookup !== 'idle' && <span className="field-status-icon" aria-hidden="true"><PinIcon /></span>}
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
                <span>{variant.cta.continue}</span><ArrowIcon />
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
                <legend>{variant.phoneStep.headline}</legend>
                <p className="question-help">{variant.phoneStep.subheadline}</p>

                <div className="phone-assurances" aria-label="Phone privacy safeguards">
                  <span><i><CheckIcon /></i><strong>For your request</strong><small>Used only to follow up on this catering inquiry</small></span>
                  <span><i><LockIcon /></i><strong>Securely handled</strong><small>Protected in our request system</small></span>
                  <span><i><ArrowIcon /></i><strong>No tracking URL</strong><small>Your phone number is never added to the page URL</small></span>
                </div>

                <label className="field-label" htmlFor="phone">{variant.phoneStep.fieldLabel}</label>
                <input
                  id="phone"
                  className="text-input"
                  data-clarity-mask="true"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  value={answers.phone || ''}
                  onChange={(event) => handlePhone(event.target.value)}
                  placeholder="(503) 555-0123"
                  aria-describedby={deliveryError ? 'phone-note delivery-error' : 'phone-note'}
                />
                <p id="phone-note" className="trust-line"><LockIcon />{variant.phoneStep.privacyCopy}</p>
              </fieldset>

              <div className="step-spacer compact" />
              <button
                className="continue-button"
                type="button"
                disabled={normalizedPhoneDigits(answers.phone || '').length !== 10 || isSavingLead}
                aria-busy={isSavingLead}
                onClick={() => void advanceIfValid(
                  normalizedPhoneDigits(answers.phone || '').length === 10,
                  'Enter a valid 10-digit phone number.',
                )}
              >
                <span>{isSavingLead ? variant.cta.saving : deliveryError ? variant.cta.retry : variant.cta.continue}</span><ArrowIcon />
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
                <p className="question-help">Your catering style is set; this tells us the occasion.</p>

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
                      data-clarity-mask="true"
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
                <span>{isSavingLead ? variant.cta.saving : variant.cta.continue}</span><ArrowIcon />
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
                      data-clarity-mask="true"
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
                <span>{isSavingLead ? variant.cta.saving : variant.cta.continue}</span><ArrowIcon />
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
                  data-clarity-mask="true"
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
                <span>{isSavingLead ? variant.cta.saving : variant.cta.finish}</span><ArrowIcon />
              </button>
            </form>
          )}

          {step === 'complete' && (
            <div className="completion-panel">
              <span className="completion-kicker">{variant.completion.kicker}</span>
              <h2>{variant.completion.headline}{answers.name ? `, ${answers.name.trim()}` : ''}.</h2>
              <p>{variant.completion.body}</p>

              <dl className="summary-list">
                <div><dt>Guests</dt><dd>{answers.guests || '—'}</dd></div>
                <div><dt>Service</dt><dd>{answers.service || '—'}</dd></div>
                <div><dt>ZIP</dt><dd>{answers.zip || '—'}{answers.city ? ` · ${answers.city}, ${answers.state}` : ''}</dd></div>
                <div><dt>Event</dt><dd>{answers.eventType || '—'}</dd></div>
                <div><dt>Timing</dt><dd>{answers.dateWindow === 'exact' ? answers.exactDate : answers.dateWindow || '—'}</dd></div>
              </dl>

              <button className="continue-button secondary-action" type="button" onClick={resetFunnel}>
                <span>{variant.cta.startNew}</span>
              </button>
            </div>
          )}

          {!isComplete && (
            <>
              {deliveryError && <p id="delivery-error" className="delivery-error" role="alert">{deliveryError}</p>}
              {announcement && !deliveryError && <p className="validation-message" role="alert">{announcement}</p>}
              <p className="privacy-note"><LockIcon />Securely handled for your catering request.</p>
            </>
          )}
          <ConsentBanner compact={stepIndex > 0} />
        </section>
      </div>
      {previewMode === 'social-proof' && <SocialProofPreview />}
      {previewMode === 'exit-intent' && <ExitIntentPreview variant={variant} />}
    </main>
  );
}

function readableValue(value: string | undefined) {
  if (!value) return null;
  return value.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ThankYouScreen() {
  const snapshot = useMemo(() => loadCompletionSnapshot(), []);
  const variant = snapshot ? resolveVariant(`/form2/${snapshot.variant}/`) : null;
  const firstName = snapshot?.firstName;
  const summary = [
    ['Event type', snapshot?.eventType],
    ['Guests', snapshot?.guests],
    ['Service', readableValue(snapshot?.service)],
    ['Timing', readableValue(snapshot?.timing)],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  useEffect(() => {
    document.title = 'Request received | Gourmet Corp';
  }, []);

  return (
    <main className="thank-you-page" data-clarity-mask="true">
      <BrandHeader />
      <div className="thank-you-aura" aria-hidden="true" />
      <section className="thank-you-card" aria-labelledby="thank-you-title">
        <span className="thank-you-check"><CheckIcon /></span>
        <p className="thank-you-kicker">{variant?.completion.kicker ?? 'REQUEST RECEIVED'}</p>
        <h1 id="thank-you-title">Thank you{firstName ? `, ${firstName}` : ''}</h1>
        <p className="thank-you-body">
          {variant?.completion.body ?? 'Your catering request has been received. Our team can now review the event details you provided.'}
        </p>
        {summary.length > 0 && (
          <dl className="thank-you-summary" aria-label="Request summary">
            {summary.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        )}
        <p className="thank-you-note"><LockIcon /> Your submitted details are not displayed in the page URL.</p>
      </section>
      <footer className="thank-you-footer">
        <strong>GOURMET CORP</strong>
        <span>FOOD BRINGS PEOPLE TOGETHER</span>
      </footer>
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
  if (/^\/form2\/thank-you\/?$/.test(window.location.pathname)) {
    // Hostinger redirects this route at the Apache layer before index.html is
    // served. This guard keeps local/dev fallbacks from initializing Form 2
    // measurement before moving to the non-legacy confirmation URL.
    window.location.replace('/form2/request-received/');
    return null;
  }
  if (/^\/form2\/request-received\/?$/.test(window.location.pathname)) return <ThankYouScreen />;
  const variant = resolveVariant(window.location.pathname);
  return variant ? <VariantFunnel variant={variant} /> : <FoundationScreen />;
}
