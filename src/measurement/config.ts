type MeasurementEnvironment = 'staging' | 'production';

function normalized(value: string | undefined, pattern: RegExp): string | null {
  const candidate = value?.trim();
  return candidate && pattern.test(candidate) ? candidate : null;
}

/**
 * Customer-facing experiments are opt-in and can never be enabled in a
 * production artifact. QA builds may opt in explicitly when exercising the
 * experiment engine.
 */
export function resolveCustomerExperimentsEnabled(
  environment: MeasurementEnvironment,
  value: string | undefined,
): boolean {
  return environment !== 'production' && value === 'true';
}

// Unit tests execute this module outside Vite, where import.meta.env is absent.
const viteEnv = import.meta.env ?? {};

const environment: MeasurementEnvironment = viteEnv.VITE_MEASUREMENT_ENVIRONMENT === 'production'
  ? 'production'
  : 'staging';

export const measurementConfig = {
  environment,
  customerExperimentsEnabled: resolveCustomerExperimentsEnabled(
    environment,
    viteEnv.VITE_CUSTOMER_EXPERIMENTS_ENABLED,
  ),
  gtmContainerId: normalized(viteEnv.VITE_GTM_CONTAINER_ID, /^GTM-[A-Z0-9]+$/i),
  ga4MeasurementId: normalized(viteEnv.VITE_GA4_MEASUREMENT_ID, /^G-[A-Z0-9]+$/i),
  googleAdsConversionId: normalized(viteEnv.VITE_GOOGLE_ADS_CONVERSION_ID, /^AW-\d+$/),
  googleAdsConversionLabel: normalized(viteEnv.VITE_GOOGLE_ADS_CONVERSION_LABEL, /^[A-Za-z0-9_-]{4,100}$/),
  clarityProjectId: normalized(viteEnv.VITE_CLARITY_PROJECT_ID, /^[A-Za-z0-9]{6,32}$/),
} as const;

export const googleAdsConfigured = Boolean(
  measurementConfig.googleAdsConversionId && measurementConfig.googleAdsConversionLabel,
);
