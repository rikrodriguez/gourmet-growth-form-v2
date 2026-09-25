import { measurementConfig } from './config';
import type { ConsentState } from './contracts';

const GTM_SCRIPT_ID = 'gourmet-growth-gtm';
const CLARITY_SCRIPT_ID = 'gourmet-growth-clarity';

export function loadGtm(): boolean {
  const id = measurementConfig.gtmContainerId;
  if (!id || document.getElementById(GTM_SCRIPT_ID)) return Boolean(id);
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  const script = document.createElement('script');
  script.id = GTM_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);
  return true;
}

function ensureClarityQueue() {
  if (window.clarity) return;
  const clarity = ((...args: unknown[]) => {
    clarity.q = clarity.q ?? [];
    clarity.q.push(args);
  }) as NonNullable<Window['clarity']>;
  window.clarity = clarity;
}

export function loadClarity(consent: ConsentState): boolean {
  const id = measurementConfig.clarityProjectId;
  if (!id || consent.analytics_storage !== 'granted') return false;
  ensureClarityQueue();
  window.clarity?.('consentv2', {
    ad_Storage: consent.ad_storage,
    analytics_Storage: consent.analytics_storage,
  });
  if (document.getElementById(CLARITY_SCRIPT_ID)) return true;
  const script = document.createElement('script');
  script.id = CLARITY_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.clarity.ms/tag/${encodeURIComponent(id)}`;
  document.head.appendChild(script);
  return true;
}

export function updateClarityConsent(consent: ConsentState) {
  if (!window.clarity) return;
  window.clarity('consentv2', {
    ad_Storage: consent.ad_storage,
    analytics_Storage: consent.analytics_storage,
  });
  if (consent.analytics_storage === 'denied') {
    window.clarity('consent', false);
  }
}
