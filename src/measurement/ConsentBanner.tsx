import { useEffect, useState } from 'react';
import { consentManager } from './consent';
import type { PersistedConsent } from './contracts';

export function ConsentBanner({ compact = false }: { compact?: boolean }) {
  const [preference, setPreference] = useState<PersistedConsent | null>(() => consentManager.initialize());
  const [managing, setManaging] = useState(false);
  const [analytics, setAnalytics] = useState(preference?.analytics_storage === 'granted');
  const [ads, setAds] = useState(preference?.ad_storage === 'granted');

  useEffect(() => consentManager.subscribe((next) => setPreference(next)), []);

  function openManager() {
    setAnalytics(preference?.analytics_storage === 'granted');
    setAds(preference?.ad_storage === 'granted');
    setManaging(true);
  }

  function save() {
    consentManager.choose(analytics, ads);
    setManaging(false);
  }

  if ((preference || compact) && !managing) {
    return (
      <button type="button" className="privacy-choices-button" onClick={openManager}>
        Privacy choices
      </button>
    );
  }

  return (
    <section className="consent-panel" role="dialog" aria-modal="false" aria-labelledby="consent-title">
      <div className="consent-copy">
        <strong id="consent-title">Your privacy choices</strong>
        <p>Optional analytics help us improve this quote experience. Your choice never blocks the quote.</p>
      </div>

      {managing && (
        <div className="consent-options">
          <div className="consent-option is-essential">
            <span><strong>Essential</strong><small>Required for the quote and security.</small></span>
            <span>Always on</span>
          </div>
          <label className="consent-option">
            <span><strong>Analytics</strong><small>GA4 and Clarity, when configured.</small></span>
            <input type="checkbox" checked={analytics} onChange={(event) => setAnalytics(event.target.checked)} />
          </label>
          <label className="consent-option">
            <span><strong>Advertising</strong><small>Conversion measurement, when configured.</small></span>
            <input type="checkbox" checked={ads} onChange={(event) => setAds(event.target.checked)} />
          </label>
        </div>
      )}

      <div className="consent-actions">
        {managing ? (
          <>
            <button type="button" onClick={save}>Save choices</button>
            {preference && <button type="button" className="is-secondary" onClick={() => setManaging(false)}>Cancel</button>}
          </>
        ) : (
          <>
            <button type="button" onClick={() => consentManager.acceptAll()}>Accept all</button>
            <button type="button" className="is-secondary" onClick={() => consentManager.rejectAll()}>Reject all</button>
            <button type="button" className="is-link" onClick={openManager}>Manage</button>
          </>
        )}
      </div>
    </section>
  );
}
