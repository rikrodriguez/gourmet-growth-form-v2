import type { FunnelVariant } from './types';

const SHARED_VISIBLE_STEPS = ['guests', 'service', 'zip', 'phone', 'event_type', 'date', 'name'] as const;
const PREFILLED_EVENT_VISIBLE_STEPS = ['guests', 'service', 'zip', 'phone', 'date', 'name'] as const;

const sharedCta = {
  continue: 'Continue',
  saving: 'Saving securely…',
  retry: 'Retry secure save',
  finish: 'Finish',
  startNew: 'Start a new quote',
} as const;

const sharedPhoneStep = {
  headline: 'What’s the best phone number to reach you?',
  subheadline: 'We’ll use it to follow up about this catering request.',
  fieldLabel: 'Mobile number',
  privacyCopy: 'Securely handled for this request.',
} as const;

const sharedProgress = {
  stepLabel: 'Step',
  shortLabel: 'Your Event',
  countLabel: 'Quick form',
} as const;

const sharedExitIntent = {
  headline: 'Need more time?',
  supportingCopy: 'Your progress stays available in this browser session.',
  ctaLabel: 'Continue my quote',
} as const;

const confirmation = {
  mode: 'confirmation',
  path: '/form2/thank-you/',
  requiresPersistedLead: true,
  safeQueryParams: [],
} as const;

export const bbqVariant = {
  schemaVersion: 1,
  slug: 'bbq',
  route: '/form2/bbq/',
  documentTitle: 'BBQ Catering in Portland | Gourmet Corp',
  serviceCategory: 'bbq',
  visibleSteps: SHARED_VISIBLE_STEPS,
  hero: {
    image: {
      src: '/form2/assets/bbq-hero-desktop-v2.webp',
      mobileSrc: '/form2/assets/bbq-hero-mobile-v2.webp',
      alt: 'BBQ catering prepared by Gourmet Corp',
      status: 'approved',
      referenceId: 'bbq-main-approved-mobile',
    },
    eyebrow: 'BBQ CATERING · PORTLAND',
    headline: ['BBQ Catering', 'in Portland'],
    subheadline: 'Tell us about your event and we’ll prepare a personalized catering quote.',
  },
  trustBadges: [
    { icon: 'leaf', lines: ['Local', 'team'] },
    { icon: 'people', lines: ['Events of', 'any size'] },
    { icon: 'star', lines: ['Custom', 'menus'] },
  ],
  proofBar: {
    headline: 'Serving Portland-area events',
    supportingCopy: 'We’ll confirm service details with your quote',
  },
  progress: sharedProgress,
  phoneStep: sharedPhoneStep,
  exitIntent: sharedExitIntent,
  cta: sharedCta,
  completion: {
    kicker: 'REQUEST RECEIVED',
    headline: 'Thank you',
    body: 'Your catering request has been received. Our team can now review the event details you provided.',
  },
  thankYou: confirmation,
  metadata: {
    variantSlug: 'bbq',
    intentCluster: 'bbq',
    serviceCategory: 'bbq',
    leadSource: 'growth-form-v2',
  },
} as const satisfies FunnelVariant;

export const funeralVariant = {
  schemaVersion: 1,
  slug: 'funeral',
  route: '/form2/funeral/',
  documentTitle: 'Funeral & Memorial Catering in Portland | Gourmet Corp',
  serviceCategory: 'funeral',
  visibleSteps: PREFILLED_EVENT_VISIBLE_STEPS,
  prefilledAnswers: { eventType: 'Memorial / Funeral' },
  hero: {
    image: { src: null, alt: 'Funeral and memorial catering', status: 'provisional', referenceId: 'funeral-gradient-v1' },
    eyebrow: 'FUNERAL & MEMORIAL CATERING · PORTLAND',
    headline: ['Thoughtful Catering', 'for Memorial Gatherings'],
    subheadline: 'Tell us a few event details and our team can prepare an appropriate catering request.',
  },
  trustBadges: [
    { icon: 'leaf', lines: ['Respectful', 'service'] },
    { icon: 'people', lines: ['Flexible guest', 'counts'] },
    { icon: 'star', lines: ['Simple', 'planning'] },
  ],
  proofBar: { headline: 'Serving Portland-area memorial gatherings', supportingCopy: 'We’ll confirm service details with your request.' },
  progress: sharedProgress,
  phoneStep: sharedPhoneStep,
  exitIntent: sharedExitIntent,
  cta: sharedCta,
  completion: { kicker: 'REQUEST RECEIVED', headline: 'Thank you', body: 'Your catering request has been received. Our team can now review the event details you provided.' },
  thankYou: confirmation,
  metadata: { variantSlug: 'funeral', intentCluster: 'funeral', serviceCategory: 'funeral', leadSource: 'growth-form-v2' },
} as const satisfies FunnelVariant;

export const corporateVariant = {
  schemaVersion: 1,
  slug: 'corporate',
  route: '/form2/corporate/',
  documentTitle: 'Corporate Catering in Portland | Gourmet Corp',
  serviceCategory: 'corporate',
  visibleSteps: PREFILLED_EVENT_VISIBLE_STEPS,
  prefilledAnswers: { eventType: 'Corporate' },
  hero: {
    image: { src: null, alt: 'Corporate catering for Portland teams', status: 'provisional', referenceId: 'corporate-gradient-v1' },
    eyebrow: 'CORPORATE CATERING · PORTLAND',
    headline: ['Corporate Catering', 'for Portland Teams'],
    subheadline: 'Tell us about your office lunch, meeting or company event and we’ll prepare a tailored catering request.',
  },
  trustBadges: [
    { icon: 'people', lines: ['Team-friendly', 'service'] },
    { icon: 'leaf', lines: ['Flexible group', 'sizes'] },
    { icon: 'star', lines: ['Custom', 'service'] },
  ],
  proofBar: { headline: 'Catering for Portland-area teams', supportingCopy: 'We’ll confirm service details with your request.' },
  progress: sharedProgress,
  phoneStep: sharedPhoneStep,
  exitIntent: sharedExitIntent,
  cta: sharedCta,
  completion: { kicker: 'REQUEST RECEIVED', headline: 'Thank you', body: 'Your catering request has been received. Our team can now review the event details you provided.' },
  thankYou: confirmation,
  metadata: { variantSlug: 'corporate', intentCluster: 'corporate', serviceCategory: 'corporate', leadSource: 'growth-form-v2' },
} as const satisfies FunnelVariant;

export const cateringNearMeVariant = {
  schemaVersion: 1,
  slug: 'catering-near-me',
  route: '/form2/catering-near-me/',
  documentTitle: 'Catering for Your Portland Event | Gourmet Corp',
  serviceCategory: 'general-catering',
  visibleSteps: SHARED_VISIBLE_STEPS,
  hero: {
    image: { src: null, alt: 'Catering for Portland events', status: 'provisional', referenceId: 'catering-near-me-gradient-v1' },
    eyebrow: 'CATERING · PORTLAND AREA',
    headline: ['Catering for', 'Your Portland Event'],
    subheadline: 'Tell us a few details and we’ll prepare a personalized catering request for your event.',
  },
  trustBadges: [
    { icon: 'leaf', lines: ['Local', 'team'] },
    { icon: 'people', lines: ['Events of', 'any size'] },
    { icon: 'star', lines: ['Flexible', 'service'] },
  ],
  proofBar: { headline: 'Serving Portland-area events', supportingCopy: 'We’ll confirm service details with your request.' },
  progress: sharedProgress,
  phoneStep: sharedPhoneStep,
  exitIntent: sharedExitIntent,
  cta: sharedCta,
  completion: { kicker: 'REQUEST RECEIVED', headline: 'Thank you', body: 'Your catering request has been received. Our team can now review the event details you provided.' },
  thankYou: confirmation,
  metadata: { variantSlug: 'catering-near-me', intentCluster: 'catering-near-me', serviceCategory: 'general-catering', leadSource: 'growth-form-v2' },
} as const satisfies FunnelVariant;

export const tacoVariant = {
  schemaVersion: 1,
  slug: 'taco',
  route: '/form2/taco/',
  documentTitle: 'Taco Catering in Portland | Gourmet Corp',
  serviceCategory: 'taco',
  visibleSteps: SHARED_VISIBLE_STEPS,
  hero: {
    image: { src: null, alt: 'Taco catering for Portland events', status: 'provisional', referenceId: 'taco-gradient-v1' },
    eyebrow: 'TACO CATERING · PORTLAND',
    headline: ['Taco Catering', 'in Portland'],
    subheadline: 'Tell us about your event and we’ll prepare a tailored taco catering request.',
  },
  trustBadges: [
    { icon: 'people', lines: ['Event-friendly', 'service'] },
    { icon: 'leaf', lines: ['Flexible guest', 'counts'] },
    { icon: 'star', lines: ['Custom', 'service'] },
  ],
  proofBar: { headline: 'Serving Portland-area events', supportingCopy: 'We’ll confirm service details with your request.' },
  progress: sharedProgress,
  phoneStep: sharedPhoneStep,
  exitIntent: sharedExitIntent,
  cta: sharedCta,
  completion: { kicker: 'REQUEST RECEIVED', headline: 'Thank you', body: 'Your catering request has been received. Our team can now review the event details you provided.' },
  thankYou: confirmation,
  metadata: { variantSlug: 'taco', intentCluster: 'taco', serviceCategory: 'taco', leadSource: 'growth-form-v2' },
} as const satisfies FunnelVariant;

const registeredVariants = [bbqVariant, funeralVariant, corporateVariant, cateringNearMeVariant, tacoVariant] as const;

export const registeredVariantMetadata = registeredVariants.map((variant) => variant.metadata);

function normalizedRoute(pathname: string): string {
  const withoutRepeatedSlashes = pathname.replace(/\/{2,}/g, '/');
  if (withoutRepeatedSlashes === '/') return '/';
  return `${withoutRepeatedSlashes.replace(/\/$/, '')}/`;
}

export function resolveVariant(pathname: string): FunnelVariant | null {
  const route = normalizedRoute(pathname);
  return registeredVariants.find((variant) => variant.route === route) ?? null;
}

export const supportedVariantRoutes = registeredVariants.map((variant) => variant.route);
