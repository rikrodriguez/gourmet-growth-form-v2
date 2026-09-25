import { buildDataManagerRequest } from './data-manager-client';
import { hashPhoneForGoogle, sha256Hex } from './normalization';

const transactionId = sha256Hex('gourmet-growth-v2:qa-enhanced:00000000-0000-4000-8000-000000000001');
const phoneHash = hashPhoneForGoogle('5035550199');
const request = buildDataManagerRequest('1112667809', '7476344812', {
  transactionId,
  eventTimestamp: '2026-09-25T12:00:00.000Z',
  phoneHash,
  adPersonalization: 'denied',
  clickIds: { gclid: 'synthetic-qa-not-delivered' },
}, true);

process.stdout.write(`${JSON.stringify({
  mode: 'local_dry_run_no_network',
  destination: 'google_ads',
  conversion_action_id: '7476344812',
  consent: { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied' },
  click_identifiers: ['gclid'],
  normalized_phone: '+1********99',
  phone_sha256: phoneHash,
  transaction_id: transactionId,
  dedupe_key: sha256Hex(`google_ads:generate_lead:${transactionId}`),
  request_validate_only: request.validateOnly,
}, null, 2)}\n`);
