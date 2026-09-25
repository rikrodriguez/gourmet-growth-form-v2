type MeasurementEnvironment = 'staging' | 'production';

function normalized(value: string | undefined, pattern: RegExp): string | null {
  const candidate = value?.trim();
  return candidate && pattern.test(candidate) ? candidate : null;
}

const environment: MeasurementEnvironment = import.meta.env.VITE_MEASUREMENT_ENVIRONMENT === 'production'
  ? 'production'
  : 'staging';

export const measurementConfig = {
  environment,
  gtmContainerId: normalized(import.meta.env.VITE_GTM_CONTAINER_ID, /^GTM-[A-Z0-9]+$/i),
  ga4MeasurementId: normalized(import.meta.env.VITE_GA4_MEASUREMENT_ID, /^G-[A-Z0-9]+$/i),
  googleAdsConversionId: normalized(import.meta.env.VITE_GOOGLE_ADS_CONVERSION_ID, /^AW-\d+$/),
  googleAdsConversionLabel: normalized(import.meta.env.VITE_GOOGLE_ADS_CONVERSION_LABEL, /^[A-Za-z0-9_-]{4,100}$/),
  clarityProjectId: normalized(import.meta.env.VITE_CLARITY_PROJECT_ID, /^[A-Za-z0-9]{6,32}$/),
} as const;

export const googleAdsConfigured = Boolean(
  measurementConfig.googleAdsConversionId && measurementConfig.googleAdsConversionLabel,
);
