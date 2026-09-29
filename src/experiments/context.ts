import { measurementConfig } from '../measurement/config';
import { resolveTelemetryIdentity, type TelemetryIdentity } from '../telemetry/identity';
import type { VariantMetadata } from '../variants/types';
import { BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID, findExperiment } from './registry';
import { resolveExperimentAssignment } from './assignment';
import type { ExperimentAssignment, ExperimentDevice } from './types';

export type ExperimentContext = {
  identity: TelemetryIdentity;
  assignment: ExperimentAssignment;
  initialViewportWidth: number;
};

function deviceForWidth(width: number): ExperimentDevice {
  if (width <= 767) return 'mobile';
  if (width <= 1023) return 'tablet';
  return 'desktop';
}

function previewVariant(search: URLSearchParams): string | null {
  const experiment = search.get('experiment_preview');
  const variant = search.get('experiment_variant');
  if (experiment !== BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID || !variant) return null;
  return variant;
}

export function resolveExperimentContext(metadata: VariantMetadata): ExperimentContext {
  const identity = resolveTelemetryIdentity();
  const initialViewportWidth = window.innerWidth;
  const experiment = findExperiment(BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID);
  if (!experiment) {
    return { identity, initialViewportWidth, assignment: { experimentId: null, variantId: null, source: 'none', eligible: false, eligibility: 'unknown_experiment' } };
  }
  const route = window.location.pathname;
  const allowQa = measurementConfig.customerExperimentsEnabled;
  return {
    identity,
    initialViewportWidth,
    assignment: resolveExperimentAssignment({
      visitorId: identity.visitorId,
      experiment,
      route,
      intentCluster: metadata.intentCluster,
      device: deviceForWidth(initialViewportWidth),
      allowQa,
      forcedVariantId: previewVariant(new URLSearchParams(window.location.search)),
      storage: window.localStorage,
    }),
  };
}
