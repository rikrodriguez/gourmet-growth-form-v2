import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deliverTelemetryBatch, type TelemetryTransport } from '../../src/telemetry/transport';
import { eventFixture } from '../helpers/fixtures';

describe('telemetry delivery queue', () => {
  it('retains every unsent event when network delivery fails', async () => {
    const queued = [eventFixture(), eventFixture()];
    const transport: TelemetryTransport = {
      configured: true,
      async send() { throw new Error('network_down'); },
      beacon() { return false; },
    };
    await assert.rejects(() => deliverTelemetryBatch(queued, transport, 20), /network_down/);
    assert.equal(queued.length, 2);
  });

  it('removes only events explicitly acknowledged by the server', async () => {
    const queued = [eventFixture(), eventFixture(), eventFixture()];
    const acknowledgedId = queued[0].event_id;
    const transport: TelemetryTransport = {
      configured: true,
      async send() { return { acknowledgedEventIds: [acknowledgedId, 'not-in-the-batch'] }; },
      beacon() { return false; },
    };
    const result = await deliverTelemetryBatch(queued, transport, 2);
    assert.equal(result.deliveredCount, 1);
    assert.deepEqual(result.remainingEvents.map((event) => event.event_id), [queued[1].event_id, queued[2].event_id]);
  });
});
