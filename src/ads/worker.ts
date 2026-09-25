import { loadAdsWorkerConfig } from './config';
import { DataManagerEnhancedConversionClient } from './data-manager-client';
import { MeasurementOutboxWorker } from './outbox-worker';
import { createMeasurementOutboxStore } from './postgres-outbox-store';

const config = loadAdsWorkerConfig();
if (config.deliveryMode === 'disabled') throw new Error('GOOGLE_ADS_DELIVERY_MODE is disabled.');
const store = createMeasurementOutboxStore(config.databaseUrl);
const client = new DataManagerEnhancedConversionClient(
  config.customerId,
  config.conversionActionId,
  config.deliveryMode,
);
const worker = new MeasurementOutboxWorker(config, store, client);

const shutdown = async () => {
  worker.stop();
  await store.close();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await worker.start();
