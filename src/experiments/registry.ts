import type { ExperimentDefinition } from './types';

export const BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID = 'bbq-first-screen-density-v1' as const;

export const experimentRegistry: readonly ExperimentDefinition[] = [
  {
    experimentId: BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID,
    status: 'qa',
    eligibleIntentClusters: ['bbq'],
    eligibleRoutes: ['/form2/bbq/'],
    eligibleDevices: ['mobile'],
    variants: [
      { id: 'control', label: 'Control', weight: 5000 },
      { id: 'compact-first-screen', label: 'Compact first screen', weight: 5000 },
    ],
    primaryMetric: 'guest_step_completion_rate',
    secondaryMetrics: [
      'phone_capture_rate',
      'form_completion_rate',
      'median_time_to_guest_completion',
      'page_exit_before_guest_completion_rate',
      'validation_error_rate_on_guests',
    ],
    guardrails: ['No automatic winner', 'No automatic stop', 'SRM warning blocks trust'],
    startAt: '2026-09-29T00:00:00.000Z',
    minimumExposedSessionsPerVariant: 200,
    minimumPrimaryConversionsPerVariant: 30,
  },
] as const;

export function findExperiment(experimentId: string | null | undefined): ExperimentDefinition | null {
  if (!experimentId) return null;
  return experimentRegistry.find((experiment) => experiment.experimentId === experimentId) ?? null;
}

export function isRegisteredExperimentPair(
  experimentId: string | null | undefined,
  variantId: string | null | undefined,
  intentCluster: string,
  route: string,
  allowQa: boolean,
): boolean {
  if (experimentId === null && variantId === null) return true;
  if (typeof experimentId !== 'string' || typeof variantId !== 'string') return false;
  const experiment = findExperiment(experimentId);
  if (!experiment || !experiment.variants.some((variant) => variant.id === variantId)) return false;
  if (experiment.status !== 'live' && !(allowQa && experiment.status === 'qa')) return false;
  return experiment.eligibleIntentClusters.includes(intentCluster)
    && experiment.eligibleRoutes.includes(route);
}

export function isQaExperimentPair(experimentId: string | null | undefined, variantId: string | null | undefined): boolean {
  const experiment = findExperiment(experimentId);
  return Boolean(experiment && experiment.status === 'qa' && experiment.variants.some((variant) => variant.id === variantId));
}
