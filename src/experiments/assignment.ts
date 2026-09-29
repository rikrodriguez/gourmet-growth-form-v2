import { findExperiment } from './registry';
import type {
  ExperimentAssignment,
  ExperimentDefinition,
  ExperimentDevice,
  PersistedExperimentAssignment,
} from './types';

export const EXPERIMENT_ASSIGNMENT_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = 'gourmet_growth_experiment_assignment_v1:';

export type AssignmentInput = {
  visitorId: string;
  experiment: ExperimentDefinition;
  route: string;
  intentCluster: string;
  device: ExperimentDevice;
  allowQa: boolean;
  now?: number;
  forcedVariantId?: string | null;
  storage?: Storage;
};

function noAssignment(eligibility: string): ExperimentAssignment {
  return { experimentId: null, variantId: null, source: 'none', eligible: false, eligibility };
}

/** FNV-1a is deterministic, non-cryptographic, and only selects an experiment bucket. */
export function experimentBucket(visitorId: string, experimentId: string): number {
  let hash = 0x811c9dc5;
  const input = `${visitorId}:${experimentId}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 10_000;
}

export function variantForBucket(experiment: ExperimentDefinition, bucket: number): string | null {
  let boundary = 0;
  for (const variant of experiment.variants) {
    boundary += variant.weight;
    if (bucket < boundary) return variant.id;
  }
  return null;
}

function parseStoredAssignment(raw: string | null, experiment: ExperimentDefinition, now: number): PersistedExperimentAssignment | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedExperimentAssignment>;
    if (parsed.version !== 1 || parsed.experiment_id !== experiment.experimentId
      || typeof parsed.variant_id !== 'string' || !experiment.variants.some((variant) => variant.id === parsed.variant_id)
      || typeof parsed.assigned_at !== 'number' || typeof parsed.expires_at !== 'number' || parsed.expires_at <= now) return null;
    return parsed as PersistedExperimentAssignment;
  } catch {
    return null;
  }
}

function eligible(input: AssignmentInput): string | null {
  const { experiment } = input;
  if (experiment.status !== 'live' && !(input.allowQa && experiment.status === 'qa')) return 'experiment_inactive';
  if (!experiment.eligibleIntentClusters.includes(input.intentCluster)) return 'intent_not_eligible';
  if (!experiment.eligibleRoutes.includes(input.route)) return 'route_not_eligible';
  if (!experiment.eligibleDevices.includes(input.device)) return 'device_not_eligible';
  return null;
}

function persist(storage: Storage | undefined, record: PersistedExperimentAssignment) {
  if (!storage) return;
  try {
    storage.setItem(`${STORAGE_PREFIX}${record.experiment_id}`, JSON.stringify(record));
  } catch {
    // Assignment remains deterministic if first-party storage is unavailable.
  }
}

export function resolveExperimentAssignment(input: AssignmentInput): ExperimentAssignment {
  const inactiveReason = eligible(input);
  if (inactiveReason) return noAssignment(inactiveReason);
  const { experiment, visitorId, storage } = input;
  const now = input.now ?? Date.now();
  if (input.forcedVariantId) {
    if (!input.allowQa || experiment.status !== 'qa' || !experiment.variants.some((variant) => variant.id === input.forcedVariantId)) {
      return noAssignment('forced_preview_rejected');
    }
    return { experimentId: experiment.experimentId, variantId: input.forcedVariantId, source: 'forced_qa', eligible: true, eligibility: 'forced_qa' };
  }
  const stored = parseStoredAssignment(storage?.getItem(`${STORAGE_PREFIX}${experiment.experimentId}`) ?? null, experiment, now);
  if (stored) {
    return { experimentId: experiment.experimentId, variantId: stored.variant_id, source: 'persisted', eligible: true, eligibility: 'eligible' };
  }
  const variantId = variantForBucket(experiment, experimentBucket(visitorId, experiment.experimentId));
  if (!variantId) return noAssignment('invalid_weights');
  persist(storage, {
    version: 1,
    experiment_id: experiment.experimentId,
    variant_id: variantId,
    assigned_at: now,
    expires_at: now + EXPERIMENT_ASSIGNMENT_TTL_MS,
  });
  return { experimentId: experiment.experimentId, variantId, source: 'deterministic', eligible: true, eligibility: 'eligible' };
}

export function resolveAssignmentForExperiment(experimentId: string, input: Omit<AssignmentInput, 'experiment'>): ExperimentAssignment {
  const experiment = findExperiment(experimentId);
  return experiment ? resolveExperimentAssignment({ ...input, experiment }) : noAssignment('unknown_experiment');
}
