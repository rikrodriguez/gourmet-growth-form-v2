import type { EventTypeAnswerValue, StepId } from '../telemetry/types';

export const VARIANT_CONFIG_VERSION = 1 as const;

export type VariantIcon = 'leaf' | 'people' | 'star';
export type VariantAssetStatus = 'approved' | 'provisional' | 'missing';

export type VariantMetadata = {
  variantSlug: string;
  intentCluster: string;
  serviceCategory: string;
  leadSource: string;
};

export type VisibleFunnelStep = Exclude<StepId, 'complete'>;

export type ThankYouBehavior =
  | {
      mode: 'confirmation';
      path: '/form2/thank-you/';
      requiresPersistedLead: true;
      safeQueryParams: readonly [];
    }
  | {
      mode: 'external';
      url: string;
      requiresPersistedLead: true;
      safeQueryParams: readonly ['variant', 'lead_source', 'utm_source', 'utm_campaign'];
    }
  | {
      mode: 'internal';
      reason: string;
      safeQueryParams: readonly [];
    }
  | {
      mode: 'blocked';
      candidateUrl: string;
      reason: string;
      safeQueryParams: readonly [];
    };

export type FunnelVariant = {
  schemaVersion: typeof VARIANT_CONFIG_VERSION;
  slug: string;
  route: `/form2/${string}/`;
  documentTitle: string;
  serviceCategory: string;
  /** Visual navigation can omit a semantic step; telemetry retains canonical IDs. */
  visibleSteps: readonly VisibleFunnelStep[];
  prefilledAnswers?: Readonly<{
    eventType?: EventTypeAnswerValue;
  }>;
  hero: {
    image: {
      src: string | null;
      mobileSrc?: string;
      alt: string;
      status: VariantAssetStatus;
      referenceId: string;
    };
    eyebrow: string;
    headline: readonly [string, string?];
    subheadline: string;
  };
  trustBadges: ReadonlyArray<{
    icon: VariantIcon;
    lines: readonly [string, string];
  }>;
  proofBar: {
    headline: string;
    supportingCopy: string;
  };
  progress: {
    stepLabel: string;
    shortLabel: string;
    countLabel: string;
  };
  phoneStep: {
    headline: string;
    subheadline: string;
    fieldLabel: string;
    privacyCopy: string;
  };
  exitIntent: {
    headline: string;
    supportingCopy: string;
    ctaLabel: string;
  };
  cta: {
    continue: string;
    saving: string;
    retry: string;
    finish: string;
    startNew: string;
  };
  completion: {
    kicker: string;
    headline: string;
    body: string;
  };
  thankYou: ThankYouBehavior;
  metadata: VariantMetadata;
};
