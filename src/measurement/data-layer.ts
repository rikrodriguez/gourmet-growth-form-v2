import type { ConsentState, MeasurementEvent } from './contracts';

function layer(): unknown[] {
  window.dataLayer = window.dataLayer ?? [];
  return window.dataLayer;
}

function gtagCommand(...args: unknown[]) {
  layer().push(args);
}

export function setDefaultConsent() {
  gtagCommand('consent', 'default', {
    analytics_storage: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    wait_for_update: 500,
  });
}

export function updateGoogleConsent(consent: ConsentState) {
  gtagCommand('consent', 'update', consent);
}

export function pushMeasurementEvent(event: MeasurementEvent) {
  layer().push(event);
}
