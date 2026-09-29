export type ExperimentStatus = 'draft' | 'qa' | 'live' | 'paused' | 'ended';
export type ExperimentDevice = 'mobile' | 'tablet' | 'desktop';
export type ExperimentAssignmentSource = 'deterministic' | 'persisted' | 'forced_qa' | 'none';

export type ExperimentVariant = {
  id: string;
  label: string;
  weight: number;
};

export type ExperimentDefinition = {
  experimentId: string;
  status: ExperimentStatus;
  eligibleIntentClusters: readonly string[];
  eligibleRoutes: readonly string[];
  eligibleDevices: readonly ExperimentDevice[];
  variants: readonly ExperimentVariant[];
  primaryMetric: 'guest_step_completion_rate';
  secondaryMetrics: readonly string[];
  guardrails: readonly string[];
  startAt: string;
  endAt?: string;
  minimumExposedSessionsPerVariant: number;
  minimumPrimaryConversionsPerVariant: number;
};

export type ExperimentAssignment = {
  experimentId: string | null;
  variantId: string | null;
  source: ExperimentAssignmentSource;
  eligible: boolean;
  eligibility: string;
};

export type PersistedExperimentAssignment = {
  version: 1;
  experiment_id: string;
  variant_id: string;
  assigned_at: number;
  expires_at: number;
};

export type ExperimentMetricsRow = {
  experiment_id: string;
  variant_id: string;
  exposed_sessions: number;
  unique_visitors: number;
  guests_completed: number;
  phone_captures: number;
  form_completes: number;
  median_time_to_guest_completion_ms: number | null;
  exits_before_guests: number;
  guest_validation_errors: number;
};
