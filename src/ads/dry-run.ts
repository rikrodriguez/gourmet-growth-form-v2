import { buildDataManagerRequest } from './data-manager-client';
import { hashPhoneForGoogle, sha256Hex } from './normalization';

const transactionId = sha256Hex('gourmet-growth-v2:qa-enhanced:00000000-0000-4000-8000-000000000001');
const phoneHash = hashPhoneForGoogle('5035550199');
const qualifiedLeadActionId = '7796776533';
const request = buildDataManagerRequest('1112667809', qualifiedLeadActionId, {
  transactionId,
  eventTimestamp: '2026-09-25T12:00:00.000Z',
  phoneHash,
  adPersonalization: 'denied',
  clickIds: {},
}, true);

process.stdout.write(`${JSON.stringify({
  mode: 'local_dry_run_no_network',
  destination: 'google_ads',
  event_semantic: 'qualified_lead',
  conversion_action_id: qualifiedLeadActionId,
  consent: { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'denied' },
  click_identifiers: [],
  transaction_id: transactionId,
  dedupe_key: sha256Hex(`google_ads:qualified_lead:${transactionId}`),
  request_validate_only: request.validateOnly,
}, null, 2)}\n`);
