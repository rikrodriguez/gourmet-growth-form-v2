import type { FunnelVariant } from './types';

const EXISTING_THANK_YOU_URL = 'https://gourmet-corporation.com/thank-you/';

export const bbqVariant = {
  schemaVersion: 1,
  slug: 'bbq',
  route: '/form2/bbq/',
  documentTitle: 'BBQ Catering in Portland | Gourmet Corp',
  serviceCategory: 'bbq',
  hero: {
    image: {
      src: null,
      alt: 'BBQ catering prepared by Gourmet Corp',
      status: 'missing',
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
  progress: {
    stepLabel: 'Step',
    shortLabel: 'Short form',
    countLabel: '7 steps',
  },
  phoneStep: {
    headline: 'What’s the best phone number to reach you?',
    subheadline: 'We’ll use it to follow up about this catering request.',
    fieldLabel: 'Mobile number',
    privacyCopy: 'Securely handled for this request.',
  },
  exitIntent: {
    headline: 'Need more time?',
    supportingCopy: 'Your progress stays available in this browser session.',
    ctaLabel: 'Continue my quote',
  },
  cta: {
    continue: 'Continue',
    saving: 'Saving securely…',
    retry: 'Retry secure save',
    finish: 'Finish',
    startNew: 'Start a new quote',
  },
  completion: {
    kicker: 'STAGING FLOW COMPLETE',
    headline: 'Thanks',
    body: 'Your BBQ catering request has been saved. Our team can now review the details you provided.',
  },
  thankYou: {
    mode: 'blocked',
    candidateUrl: EXISTING_THANK_YOU_URL,
    reason: 'The candidate currently serves a new lead-generation landing page, not a post-submit confirmation experience.',
    safeQueryParams: [],
  },
  metadata: {
    variantSlug: 'bbq',
    intentCluster: 'bbq',
    serviceCategory: 'bbq',
    leadSource: 'growth-form-v2',
  },
} as const satisfies FunnelVariant;

const registeredVariants = [bbqVariant] as const;

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
