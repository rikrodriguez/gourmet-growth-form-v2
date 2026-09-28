import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bbqVariant, resolveVariant, supportedVariantRoutes } from '../../src/variants/registry';
import { buildThankYouRedirectUrl } from '../../src/variants/thank-you';
import type { AttributionContext } from '../../src/telemetry/types';
import type { FunnelVariant } from '../../src/variants/types';

function attribution(): AttributionContext {
  const touch = {
    captured_at: '2026-09-28T12:00:00.000Z',
    landing_path: '/form2/bbq/',
    landing_url_without_pii: 'https://gourmet-corporation.com/form2/bbq/',
    referrer: null,
    intent_cluster: 'bbq',
    utm_source: 'google',
    utm_campaign: 'portland bbq',
  } as const;
  return { first_touch: touch, latest_touch: touch };
}

describe('variant registry', () => {
  it('registers only the approved BBQ route and matches it exactly', () => {
    assert.deepEqual(supportedVariantRoutes, ['/form2/bbq/']);
    assert.equal(resolveVariant('/form2/bbq'), bbqVariant);
    assert.equal(resolveVariant('/form2/bbq/'), bbqVariant);
    assert.equal(resolveVariant('/form2/bbq-unapproved/'), null);
    assert.equal(resolveVariant('/form2/funeral/'), null);
  });

  it('routes completed BBQ leads to the dedicated V2 confirmation without query data', () => {
    const url = new URL(buildThankYouRedirectUrl(bbqVariant, attribution())!);
    assert.equal(url.pathname, '/form2/thank-you/');
    assert.equal(url.search, '');
  });

  it('uses the approved responsive BBQ hero derivatives', () => {
    assert.equal(bbqVariant.hero.image.status, 'approved');
    assert.equal(bbqVariant.hero.image.src, '/form2/assets/bbq-hero-desktop-v2.webp');
    assert.equal(bbqVariant.hero.image.mobileSrc, '/form2/assets/bbq-hero-mobile-v2.webp');
  });

  it('builds only the allowlisted non-PII redirect context after activation', () => {
    const activeVariant: FunnelVariant = {
      ...bbqVariant,
      thankYou: {
        mode: 'external',
        url: 'https://gourmet-corporation.com/thank-you/',
        requiresPersistedLead: true,
        safeQueryParams: ['variant', 'lead_source', 'utm_source', 'utm_campaign'],
      },
    };
    const url = new URL(buildThankYouRedirectUrl(activeVariant, attribution())!);
    assert.deepEqual([...url.searchParams.keys()], [
      'variant', 'lead_source', 'utm_source', 'utm_campaign',
    ]);
    assert.equal(url.searchParams.get('variant'), 'bbq');
    assert.equal(url.searchParams.get('lead_source'), 'growth-form-v2');
    assert.equal(url.searchParams.get('utm_source'), 'google');
    assert.equal(url.searchParams.get('utm_campaign'), 'portland bbq');
    assert.equal(url.searchParams.has('visitor_id'), false);
    assert.equal(url.searchParams.has('session_id'), false);
    assert.equal(url.searchParams.has('phone'), false);
    assert.equal(url.searchParams.has('name'), false);
  });
});
