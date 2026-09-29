import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { experimentBucket, resolveAssignmentForExperiment, resolveExperimentAssignment, variantForBucket } from '../../src/experiments/assignment';
import { BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID, findExperiment } from '../../src/experiments/registry';
import { buildExperimentReport, sampleRatioMismatch } from '../../src/experiments/statistics';

const experiment = findExperiment(BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID)!;
const base = {
  route: '/form2/bbq/', intentCluster: 'bbq', device: 'mobile' as const, allowQa: true, now: 10,
};

describe('M4C first-party experiment assignment', () => {
  it('is deterministic, reaches both registered variants, and honours weight boundaries', () => {
    const first = resolveExperimentAssignment({ ...base, visitorId: 'visitor-one', experiment });
    const repeated = resolveExperimentAssignment({ ...base, visitorId: 'visitor-one', experiment });
    assert.deepEqual(first, repeated);
    const variants = new Set(Array.from({ length: 200 }, (_, index) => resolveExperimentAssignment({ ...base, visitorId: `visitor-${index}`, experiment }).variantId));
    assert.deepEqual(variants, new Set(['control', 'compact-first-screen']));
    assert.equal(variantForBucket(experiment, 0), 'control');
    assert.equal(variantForBucket(experiment, 4999), 'control');
    assert.equal(variantForBucket(experiment, 5000), 'compact-first-screen');
    assert.equal(variantForBucket(experiment, 9999), 'compact-first-screen');
    assert.equal(experimentBucket('visitor-one', experiment.experimentId), experimentBucket('visitor-one', experiment.experimentId));
  });

  it('refuses unknown, inactive, route, intent, and device-ineligible assignment', () => {
    assert.equal(resolveAssignmentForExperiment('unknown-experiment', { ...base, visitorId: 'visitor' }).variantId, null);
    assert.equal(resolveExperimentAssignment({ ...base, visitorId: 'visitor', experiment, route: '/form2/taco/' }).variantId, null);
    assert.equal(resolveExperimentAssignment({ ...base, visitorId: 'visitor', experiment, intentCluster: 'taco' }).variantId, null);
    assert.equal(resolveExperimentAssignment({ ...base, visitorId: 'visitor', experiment, device: 'desktop' }).variantId, null);
    assert.equal(resolveExperimentAssignment({ ...base, visitorId: 'visitor', experiment, allowQa: false }).variantId, null);
  });

  it('honours staging-only forced QA preview without changing normal persisted assignment', () => {
    const preview = resolveExperimentAssignment({ ...base, visitorId: 'visitor', experiment, forcedVariantId: 'compact-first-screen' });
    assert.deepEqual(preview, {
      experimentId: BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID, variantId: 'compact-first-screen', source: 'forced_qa', eligible: true, eligibility: 'forced_qa',
    });
    assert.equal(resolveExperimentAssignment({ ...base, visitorId: 'visitor', experiment, allowQa: false, forcedVariantId: 'compact-first-screen' }).variantId, null);
  });
});

describe('M4C experiment reporting math', () => {
  it('calculates rates, lift, median, QA sample status, and SRM deterministically', () => {
    const report = buildExperimentReport([
      { experiment_id: BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID, variant_id: 'control', exposed_sessions: 50, unique_visitors: 49, guests_completed: 20, phone_captures: 12, form_completes: 8, median_time_to_guest_completion_ms: 1300, exits_before_guests: 10, guest_validation_errors: 2 },
      { experiment_id: BBQ_FIRST_SCREEN_DENSITY_EXPERIMENT_ID, variant_id: 'compact-first-screen', exposed_sessions: 50, unique_visitors: 48, guests_completed: 25, phone_captures: 15, form_completes: 11, median_time_to_guest_completion_ms: 900, exits_before_guests: 7, guest_validation_errors: 1 },
    ]);
    const item = report.experiments[0] as any;
    assert.equal(item.variants.find((variant: any) => variant.variant_id === 'control').guest_step_completion_rate, 40);
    assert.equal(item.variants.find((variant: any) => variant.variant_id === 'compact-first-screen').guest_step_completion_rate, 50);
    assert.equal(item.comparison.primary_metric_absolute_pp, 10);
    assert.equal(item.comparison.primary_metric_relative_lift, 25);
    assert.equal(item.variants[0].evidence_state, 'INSUFFICIENT_DATA');
    assert.equal(item.srm.status, 'SRM_OK');
    assert.equal(sampleRatioMismatch(900, 100).status, 'SRM_WARNING');
  });
});
