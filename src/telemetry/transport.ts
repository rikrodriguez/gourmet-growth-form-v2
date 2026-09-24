import type { GourmetTelemetryEvent } from './types';

const REQUEST_TIMEOUT_MS = 4_000;

export type DeliveryResult = {
  acknowledgedEventIds: string[];
};

export interface TelemetryTransport {
  readonly configured: boolean;
  send(events: GourmetTelemetryEvent[]): Promise<DeliveryResult>;
  beacon(events: GourmetTelemetryEvent[]): boolean;
}

export async function deliverTelemetryBatch(
  queuedEvents: GourmetTelemetryEvent[],
  transport: TelemetryTransport,
  batchSize: number,
): Promise<{ remainingEvents: GourmetTelemetryEvent[]; deliveredCount: number }> {
  const batch = queuedEvents.slice(0, batchSize);
  if (!transport.configured || batch.length === 0) {
    return { remainingEvents: queuedEvents, deliveredCount: 0 };
  }
  const result = await transport.send(batch);
  const sentIds = new Set(batch.map((event) => event.event_id));
  const acknowledged = new Set(result.acknowledgedEventIds.filter((id) => sentIds.has(id)));
  if (acknowledged.size === 0) throw new Error('telemetry_not_acknowledged');
  return {
    remainingEvents: queuedEvents.filter((event) => !acknowledged.has(event.event_id)),
    deliveredCount: acknowledged.size,
  };
}

export function createTelemetryTransport(apiBaseUrl: string | null): TelemetryTransport {
  return {
    configured: Boolean(apiBaseUrl),

    async send(events) {
      if (!apiBaseUrl || events.length === 0) return { acknowledgedEventIds: [] };
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${apiBaseUrl}/v1/events/batch`, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ events }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('telemetry_delivery_failed');
        const body = await response.json() as { acknowledged_event_ids?: unknown };
        const acknowledgedEventIds = Array.isArray(body.acknowledged_event_ids)
          ? body.acknowledged_event_ids.filter((value): value is string => typeof value === 'string')
          : [];
        return { acknowledgedEventIds };
      } finally {
        window.clearTimeout(timeout);
      }
    },

    beacon(events) {
      if (!apiBaseUrl || events.length === 0 || typeof navigator.sendBeacon !== 'function') return false;
      const payload = new Blob([JSON.stringify({ events })], { type: 'application/json' });
      return navigator.sendBeacon(`${apiBaseUrl}/v1/events/batch`, payload);
    },
  };
}
