import { ATTRIBUTION_KEYS, AttributionKey, AttributionTouch, AttributionContext } from './types';

const FIRST_TOUCH_STORAGE_KEY = 'gourmet_growth_attribution_first_v1';
const LATEST_TOUCH_STORAGE_KEY = 'gourmet_growth_attribution_latest_v1';
const ATTRIBUTION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_VALUE_LENGTH = 200;
const REJECT_VALUE_LENGTH = 512;

type StoredTouch = {
  version: 1;
  expires_at: number;
  touch: AttributionTouch;
};

function sanitizedValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!normalized || normalized.length > REJECT_VALUE_LENGTH) return undefined;
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(normalized)) return undefined;
  if (/(?:\+?\d[\s().-]*){7,}/.test(normalized)) return undefined;
  return normalized.slice(0, MAX_VALUE_LENGTH);
}

function safePath(pathname: string): string {
  const cleaned = pathname.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
  return cleaned.startsWith('/') ? cleaned : '/';
}

function safeReferrer(referrer: string): string | null {
  if (!referrer) return null;
  try {
    const parsed = new URL(referrer);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin.slice(0, 200) : null;
  } catch {
    return null;
  }
}

function captureTouch(now: number): AttributionTouch {
  const url = new URL(window.location.href);
  const landingPath = safePath(url.pathname);
  const allowedValues: Partial<Record<AttributionKey, string>> = {};

  for (const key of ATTRIBUTION_KEYS) {
    const value = sanitizedValue(url.searchParams.get(key));
    if (value) allowedValues[key] = value;
  }

  return {
    ...allowedValues,
    captured_at: new Date(now).toISOString(),
    landing_path: landingPath,
    landing_url_without_pii: `${url.origin}${landingPath}`.slice(0, 500),
    referrer: safeReferrer(document.referrer),
    intent_cluster: 'bbq',
  };
}

function parseStoredTouch(raw: string | null, now: number): AttributionTouch | null {
  if (!raw) return null;
  try {
    const stored = JSON.parse(raw) as Partial<StoredTouch>;
    if (
      stored.version === 1
      && typeof stored.expires_at === 'number'
      && stored.expires_at > now
      && stored.touch?.intent_cluster === 'bbq'
      && typeof stored.touch.landing_path === 'string'
      && typeof stored.touch.landing_url_without_pii === 'string'
    ) {
      return stored.touch;
    }
  } catch {
    // Invalid attribution is discarded rather than propagated.
  }
  return null;
}

function persist(key: string, touch: AttributionTouch, now: number) {
  const stored: StoredTouch = {
    version: 1,
    expires_at: now + ATTRIBUTION_TTL_MS,
    touch,
  };
  window.localStorage.setItem(key, JSON.stringify(stored));
}

export function resolveAttribution(now = Date.now()): AttributionContext {
  const latestTouch = captureTouch(now);
  const firstTouch = parseStoredTouch(window.localStorage.getItem(FIRST_TOUCH_STORAGE_KEY), now) ?? latestTouch;

  persist(FIRST_TOUCH_STORAGE_KEY, firstTouch, now);
  persist(LATEST_TOUCH_STORAGE_KEY, latestTouch, now);

  return { first_touch: firstTouch, latest_touch: latestTouch };
}
