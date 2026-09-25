/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GOURMET_API_BASE_URL?: string;
  readonly VITE_MEASUREMENT_ENVIRONMENT?: 'staging' | 'production';
  readonly VITE_GTM_CONTAINER_ID?: string;
  readonly VITE_GA4_MEASUREMENT_ID?: string;
  readonly VITE_GOOGLE_ADS_CONVERSION_ID?: string;
  readonly VITE_GOOGLE_ADS_CONVERSION_LABEL?: string;
  readonly VITE_CLARITY_PROJECT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
