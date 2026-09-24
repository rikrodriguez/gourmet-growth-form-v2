import { randomUUID } from 'node:crypto';
import type { AttributionContext, GourmetTelemetryEvent } from '../../src/telemetry/types';

export function attribution(): AttributionContext {
  const capturedAt = new Date().toISOString();
  return {
    first_touch: {
      captured_at: capturedAt,
      landing_path: '/form2/bbq/',
      landing_url_without_pii: 'https://gourmet-corporation.com/form2/bbq/',
      referrer: null,
      intent_cluster: 'bbq',
      utm_source: 'qa',
    },
    latest_touch: {
      captured_at: capturedAt,
      landing_path: '/form2/bbq/',
      landing_url_without_pii: 'https://gourmet-corporation.com/form2/bbq/',
      referrer: null,
      intent_cluster: 'bbq',
      utm_source: 'qa',
    },
  };
}
export function eventFixture(overrides: Partial<GourmetTelemetryEvent> = {}): GourmetTelemetryEvent {
  return {
    schema_version: '1.0',
    event_id: randomUUID(),
    event_name: 'step_viewed',
    occurred_at: new Date().toISOString(),
    visitor_id: randomUUID(),
    session_id: randomUUID(),
    intent_cluster: 'bbq',
    route: '/form2/bbq/',
    step_id: 'guests',
    step_index: 1,
    properties: {},
    experiment_id: null,
    variant_id: null,
    step_duration_ms: null,
    session_elapsed_ms: 10,
    attribution: attribution(),
    ...overrides,
  } as GourmetTelemetryEvent;
}
