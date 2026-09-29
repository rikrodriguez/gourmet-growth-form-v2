import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { eventFixture } from '../helpers/fixtures';
import {
  findPiiKey,
  normalizeUsPhone,
  validateCapturePhone,
  validateEvent,
  validateLeadPatch,
} from '../../src/backend/validation';

describe('server-side validation', () => {
  it('accepts the M0C contract and rejects unknown events', () => {
    assert.ok(validateEvent(eventFixture()).event);
    const unknown = { ...eventFixture(), event_name: 'abandoned' };
    assert.equal(validateEvent(unknown).rejection?.code, 'unsupported_contract');
  });

  it('allows only the registered BBQ QA experiment pair on staging', () => {
    const experiment = eventFixture({
      experiment_id: 'bbq-first-screen-density-v1',
      variant_id: 'compact-first-screen',
    });
    assert.ok(validateEvent(experiment, new Date(), { allowQaExperiments: true }).event);
    assert.equal(
      validateEvent({ ...experiment, variant_id: 'not-a-variant' }, new Date(), { allowQaExperiments: true }).rejection?.code,
      'invalid_experiment_assignment',
    );
    assert.equal(
      validateEvent(experiment, new Date(), { allowQaExperiments: false }).rejection?.code,
      'invalid_experiment_assignment',
    );
    assert.equal(
      validateEvent({ ...experiment, intent_cluster: 'corporate', route: '/form2/corporate/' }, new Date(), { allowQaExperiments: true }).rejection?.code,
      'invalid_experiment_assignment',
    );
  });

  it('accepts every registered intent identifier and rejects unregistered identifiers', () => {
    const registeredVariant = eventFixture();
    assert.ok(validateEvent(registeredVariant).event);
    for (const intent of ['funeral', 'corporate', 'catering-near-me', 'taco']) {
      const variant = {
        ...registeredVariant,
        intent_cluster: intent,
        route: `/form2/${intent}/`,
        attribution: {
          first_touch: { ...eventFixture().attribution.first_touch, intent_cluster: intent, landing_path: `/form2/${intent}/`, landing_url_without_pii: `https://gourmet-corporation.com/form2/${intent}/` },
          latest_touch: { ...eventFixture().attribution.latest_touch, intent_cluster: intent, landing_path: `/form2/${intent}/`, landing_url_without_pii: `https://gourmet-corporation.com/form2/${intent}/` },
        },
      };
      assert.ok(validateEvent(variant).event);
    }
    assert.equal(validateEvent({ ...registeredVariant, intent_cluster: '../unsafe' }).rejection?.code, 'invalid_intent_cluster');
  });

  it('rejects likely phone or email PII hidden in attribution values', () => {
    const phoneAttribution = eventFixture();
    phoneAttribution.attribution.latest_touch.utm_term = '5035550123';
    assert.equal(validateEvent(phoneAttribution).rejection?.code, 'invalid_attribution');
    const emailAttribution = eventFixture();
    emailAttribution.attribution.latest_touch.utm_content = 'qa@example.com';
    assert.equal(validateEvent(emailAttribution).rejection?.code, 'invalid_attribution');
  });

  it('rejects direct and recursively nested telemetry PII keys', () => {
    const direct = eventFixture({ properties: { phone: '5035550123' } } as never);
    const nested = eventFixture({ properties: { safe: { customer: { email: 'qa@example.com' } } } } as never);
    assert.equal(validateEvent(direct).rejection?.code, 'pii_key_rejected');
    assert.equal(validateEvent(nested).rejection?.code, 'pii_key_rejected');
    assert.equal(findPiiKey({ safe: [{ first_name: 'QA' }] }), 'first_name');
  });

  it('normalizes valid US phones and rejects invalid structures', () => {
    assert.equal(normalizeUsPhone('(503) 555-0123'), '5035550123');
    assert.equal(normalizeUsPhone('+1 503 555 0123'), '5035550123');
    assert.equal(normalizeUsPhone('12345'), null);
    assert.equal(normalizeUsPhone('1035550123'), null);
  });

  it('strictly allowlists lead capture and progressive fields', () => {
    const capture = validateCapturePhone({
      visitor_id: randomUUID(),
      session_id: randomUUID(),
      phone: '5035550123',
      intent_cluster: 'bbq',
      idempotency_key: randomUUID(),
      answers: { guest_range: '26-50', service_style: 'full-service', zip_code: '97205' },
    });
    assert.ok(capture.input);
    assert.ok(validateCapturePhone({ ...capture.input, intent_cluster: 'corporate', answers: { ...capture.input.answers, event_type: 'Corporate' } }).input);
    assert.equal(validateCapturePhone({ ...capture.input, admin: true }).code, 'invalid_shape');
    assert.ok(validateCapturePhone({
      ...capture.input,
      experiment_id: 'bbq-first-screen-density-v1',
      variant_id: 'control',
    }, { allowQaExperiments: true }).input);
    assert.equal(validateCapturePhone({
      ...capture.input,
      experiment_id: 'bbq-first-screen-density-v1',
      variant_id: 'wrong',
    }, { allowQaExperiments: true }).code, 'invalid_experiment_assignment');
    assert.deepEqual(validateLeadPatch({ event_type: 'Corporate', first_name: 'QA' }), {
      event_type: 'Corporate',
      first_name: 'QA',
    });
    assert.equal(validateLeadPatch({ status: 'won' }), null);
  });
});
