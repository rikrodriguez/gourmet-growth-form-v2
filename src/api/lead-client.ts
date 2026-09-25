import type { AttributionContext } from '../telemetry/types';
import { gourmetApiBaseUrl } from './config';

const LEAD_ID_STORAGE_KEY = 'gourmet_growth_lead_id_v1';
const CAPTURE_IDEMPOTENCY_STORAGE_KEY = 'gourmet_growth_lead_capture_idempotency_v1';
const CAPTURE_PHONE_STORAGE_KEY = 'gourmet_growth_lead_capture_phone_v1';
const REQUEST_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSION_ID_PATTERN = /^[a-f0-9]{64}$/;
const CONVERSION_ID_NAMESPACE = 'gourmet-growth-v2:google-ads:generate_lead:v1:';

type LeadContext = {
  visitor_id: string;
  session_id: string;
  attribution: AttributionContext;
};

type PrePhoneAnswers = {
  guest_range?: string;
  service_style?: string;
  zip_code?: string;
};

type LeadUpdates = {
  event_type?: string;
  date_window?: string;
  exact_date?: string | null;
  first_name?: string;
};

type MeasurementConsentEvidence = {
  version: 1;
  updated_at: string;
  ad_storage: 'granted' | 'denied';
  ad_user_data: 'granted' | 'denied';
  ad_personalization: 'granted' | 'denied';
};

type CapturedLead = { leadId: string; conversionId: string };

export class LeadDeliveryError extends Error {
  constructor() {
    super('The lead could not be saved securely.');
    this.name = 'LeadDeliveryError';
  }
}

function sessionValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function persistSessionValue(key: string, value: string) {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // The active UI state remains available when browser storage is unavailable.
  }
}

async function request(path: string, init: RequestInit): Promise<Response> {
  if (!gourmetApiBaseUrl) throw new LeadDeliveryError();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${gourmetApiBaseUrl}${path}`, {
      ...init,
      credentials: 'omit',
      headers: { 'content-type': 'application/json', ...init.headers },
      signal: controller.signal,
    });
  } catch {
    throw new LeadDeliveryError();
  } finally {
    window.clearTimeout(timeout);
  }
}

async function deriveOpaqueConversionId(leadId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${CONVERSION_ID_NAMESPACE}${leadId}`),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const leadClient = {
  isConfigured: Boolean(gourmetApiBaseUrl),

  getLeadId(): string | null {
    return sessionValue(LEAD_ID_STORAGE_KEY);
  },

  async capturePhone(
    context: LeadContext,
    phone: string,
    answers: PrePhoneAnswers,
    measurementConsent: MeasurementConsentEvidence | null,
  ): Promise<CapturedLead | null> {
    if (!gourmetApiBaseUrl) return null;
    let idempotencyKey = sessionValue(CAPTURE_IDEMPOTENCY_STORAGE_KEY);
    const previousPhone = sessionValue(CAPTURE_PHONE_STORAGE_KEY);
    if (!idempotencyKey || previousPhone !== phone) {
      idempotencyKey = crypto.randomUUID();
      persistSessionValue(CAPTURE_IDEMPOTENCY_STORAGE_KEY, idempotencyKey);
      persistSessionValue(CAPTURE_PHONE_STORAGE_KEY, phone);
    }
    const response = await request('/v1/leads/capture-phone', {
      method: 'POST',
      body: JSON.stringify({
        visitor_id: context.visitor_id,
        session_id: context.session_id,
        phone,
        intent_cluster: 'bbq',
        idempotency_key: idempotencyKey,
        attribution: context.attribution,
        answers,
        measurement_consent: measurementConsent,
      }),
    });
    if (!response.ok) throw new LeadDeliveryError();
    const body = await response.json() as { lead_id?: unknown; conversion_id?: unknown };
    if (typeof body.lead_id !== 'string' || !UUID_PATTERN.test(body.lead_id)) {
      throw new LeadDeliveryError();
    }
    // Compatibility bridge for the already-deployed staging API. The server and
    // browser use the same namespaced SHA-256 algorithm, and only the opaque hash
    // reaches measurement. Remove after every backend environment returns it.
    const conversionId = typeof body.conversion_id === 'string' && CONVERSION_ID_PATTERN.test(body.conversion_id)
      ? body.conversion_id
      : await deriveOpaqueConversionId(body.lead_id);
    persistSessionValue(LEAD_ID_STORAGE_KEY, body.lead_id);
    return { leadId: body.lead_id, conversionId };
  },

  async update(leadId: string, sessionId: string, updates: LeadUpdates): Promise<void> {
    if (!gourmetApiBaseUrl) return;
    const response = await request(`/v1/leads/${encodeURIComponent(leadId)}`, {
      method: 'PATCH',
      headers: { 'x-gourmet-session-id': sessionId },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new LeadDeliveryError();
  },

  reset() {
    try {
      window.sessionStorage.removeItem(LEAD_ID_STORAGE_KEY);
      window.sessionStorage.removeItem(CAPTURE_IDEMPOTENCY_STORAGE_KEY);
      window.sessionStorage.removeItem(CAPTURE_PHONE_STORAGE_KEY);
    } catch {
      // Ignore unavailable browser storage.
    }
  },
};
