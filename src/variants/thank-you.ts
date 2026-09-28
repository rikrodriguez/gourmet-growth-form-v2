import type { AttributionContext } from '../telemetry/types';
import type { FunnelVariant } from './types';

const SAFE_VALUE_PATTERN = /^[\w .~+-]{1,200}$/;

function safeValue(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return SAFE_VALUE_PATTERN.test(normalized) ? normalized : null;
}

export function buildThankYouRedirectUrl(
  variant: FunnelVariant,
  attribution: AttributionContext,
  baseOrigin = 'https://gourmet-corporation.com',
): string | null {
  if (variant.thankYou.mode === 'confirmation') {
    return new URL(variant.thankYou.path, baseOrigin).toString();
  }
  if (variant.thankYou.mode !== 'external') return null;

  const url = new URL(variant.thankYou.url);
  const latest = attribution.latest_touch;
  const values = {
    variant: variant.slug,
    lead_source: variant.metadata.leadSource,
    utm_source: latest.utm_source,
    utm_campaign: latest.utm_campaign,
  } as const;

  for (const key of variant.thankYou.safeQueryParams) {
    const value = safeValue(values[key]);
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}
