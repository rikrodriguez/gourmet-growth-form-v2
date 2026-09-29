import { findExperiment } from './registry';
import type { ExperimentMetricsRow } from './types';

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function rounded(value: number | null, digits = 1): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// Abramowitz and Stegun 7.1.26, sufficient for the dashboard SRM warning threshold.
function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return sign * y;
}

export function sampleRatioMismatch(observedControl: number, observedChallenger: number) {
  const total = observedControl + observedChallenger;
  if (total === 0) return { expected_control: 0, expected_challenger: 0, chi_square: 0, p_value: 1, status: 'INSUFFICIENT_DATA' as const };
  const expected = total / 2;
  const chiSquare = ((observedControl - expected) ** 2 / expected) + ((observedChallenger - expected) ** 2 / expected);
  const pValue = 1 - erf(Math.sqrt(chiSquare / 2));
  return {
    expected_control: expected,
    expected_challenger: expected,
    chi_square: rounded(chiSquare, 4)!,
    p_value: rounded(pValue, 6)!,
    status: pValue < 0.001 ? 'SRM_WARNING' as const : 'SRM_OK' as const,
  };
}

export function buildExperimentReport(rows: readonly ExperimentMetricsRow[]) {
  const experiment = findExperiment(rows[0]?.experiment_id);
  if (!experiment) return { experiments: [] };
  const variants = experiment.variants.map((variant) => {
    const row = rows.find((candidate) => candidate.variant_id === variant.id) ?? {
      experiment_id: experiment.experimentId, variant_id: variant.id, exposed_sessions: 0, unique_visitors: 0,
      guests_completed: 0, phone_captures: 0, form_completes: 0, median_time_to_guest_completion_ms: null,
      exits_before_guests: 0, guest_validation_errors: 0,
    };
    const exposed = Number(row.exposed_sessions);
    const guestRate = rate(Number(row.guests_completed), exposed);
    return {
      ...row,
      label: variant.label,
      guest_step_completion_rate: rounded(guestRate * 100)!,
      phone_capture_rate: rounded(rate(Number(row.phone_captures), exposed) * 100)!,
      form_completion_rate: rounded(rate(Number(row.form_completes), exposed) * 100)!,
      page_exit_before_guest_completion_rate: rounded(rate(Number(row.exits_before_guests), exposed) * 100)!,
      guest_validation_error_rate: rounded(rate(Number(row.guest_validation_errors), exposed) * 100)!,
      evidence_state: exposed >= experiment.minimumExposedSessionsPerVariant && Number(row.guests_completed) >= experiment.minimumPrimaryConversionsPerVariant
        ? 'THRESHOLD_REACHED' : 'INSUFFICIENT_DATA',
    };
  });
  const control = variants.find((variant) => variant.variant_id === 'control')!;
  const challenger = variants.find((variant) => variant.variant_id === 'compact-first-screen')!;
  const absolutePp = challenger.guest_step_completion_rate - control.guest_step_completion_rate;
  const relativeLift = control.guest_step_completion_rate > 0
    ? ((challenger.guest_step_completion_rate / control.guest_step_completion_rate) - 1) * 100 : null;
  return {
    experiments: [{
      experiment_id: experiment.experimentId,
      status: experiment.status,
      intent_clusters: experiment.eligibleIntentClusters,
      routes: experiment.eligibleRoutes,
      primary_metric: experiment.primaryMetric,
      variants,
      comparison: {
        control_variant_id: 'control',
        challenger_variant_id: 'compact-first-screen',
        primary_metric_absolute_pp: rounded(absolutePp)!,
        primary_metric_relative_lift: rounded(relativeLift),
      },
      srm: sampleRatioMismatch(control.exposed_sessions, challenger.exposed_sessions),
      minimum_sample: {
        exposed_sessions_per_variant: experiment.minimumExposedSessionsPerVariant,
        primary_conversions_per_variant: experiment.minimumPrimaryConversionsPerVariant,
      },
    }],
  };
}
