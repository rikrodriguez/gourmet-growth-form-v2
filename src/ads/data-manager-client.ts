import { IngestionServiceClient, protos } from '@google-ads/datamanager';
import type { AdsDeliveryMode } from './config';
import type { EnhancedConversionClient, EnhancedConversionDelivery } from './contracts';

const dm = protos.google.ads.datamanager.v1;

export class DataManagerDeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = 'DataManagerDeliveryError';
  }
}

export function buildDataManagerRequest(
  customerId: string,
  conversionActionId: string,
  event: EnhancedConversionDelivery,
  validateOnly: boolean,
) {
  const adIdentifiers = Object.fromEntries(
    Object.entries(event.clickIds).filter(([, value]) => Boolean(value)),
  );
  return dm.IngestEventsRequest.create({
    destinations: [dm.Destination.create({
      operatingAccount: dm.ProductAccount.create({
        accountType: dm.ProductAccount.AccountType.GOOGLE_ADS,
        accountId: customerId,
      }),
      loginAccount: dm.ProductAccount.create({
        accountType: dm.ProductAccount.AccountType.GOOGLE_ADS,
        accountId: customerId,
      }),
      productDestinationId: conversionActionId,
    })],
    events: [dm.Event.create({
      adIdentifiers: dm.AdIdentifiers.create(adIdentifiers),
      eventTimestamp: { seconds: Math.floor(Date.parse(event.eventTimestamp) / 1000) },
      transactionId: event.transactionId,
      eventSource: dm.EventSource.WEB,
      userData: dm.UserData.create({
        userIdentifiers: [dm.UserIdentifier.create({ phoneNumber: event.phoneHash })],
      }),
    })],
    consent: dm.Consent.create({
      adUserData: dm.ConsentStatus.CONSENT_GRANTED,
      adPersonalization: event.adPersonalization === 'granted'
        ? dm.ConsentStatus.CONSENT_GRANTED
        : dm.ConsentStatus.CONSENT_DENIED,
    }),
    encoding: dm.Encoding.HEX,
    validateOnly,
  });
}

export class DataManagerEnhancedConversionClient implements EnhancedConversionClient {
  private readonly client = new IngestionServiceClient();

  constructor(
    private readonly customerId: string,
    private readonly conversionActionId: string,
    private readonly mode: Exclude<AdsDeliveryMode, 'disabled'>,
  ) {}

  async deliver(event: EnhancedConversionDelivery): Promise<{ requestId: string | null }> {
    try {
      const [response] = await this.client.ingestEvents(buildDataManagerRequest(
        this.customerId,
        this.conversionActionId,
        event,
        this.mode === 'validate-only',
      ));
      return { requestId: response.requestId || null };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'data_manager_error';
      const numeric = Number(code);
      throw new DataManagerDeliveryError(code, !Number.isFinite(numeric) || numeric === 4 || numeric === 8 || numeric === 13 || numeric === 14);
    }
  }
}
