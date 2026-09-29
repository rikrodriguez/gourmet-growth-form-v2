import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bbqVariant,
  cateringNearMeVariant,
  corporateVariant,
  funeralVariant,
  resolveVariant,
  supportedVariantRoutes,
  tacoVariant,
} from '../../src/variants/registry';
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
  it('registers the shared BBQ baseline and four configuration-driven intent routes', () => {
    assert.deepEqual(supportedVariantRoutes, [
      '/form2/bbq/', '/form2/funeral/', '/form2/corporate/', '/form2/catering-near-me/', '/form2/taco/',
    ]);
    assert.equal(resolveVariant('/form2/bbq'), bbqVariant);
    assert.equal(resolveVariant('/form2/bbq/'), bbqVariant);
    assert.equal(resolveVariant('/form2/bbq-unapproved/'), null);
    assert.equal(resolveVariant('/form2/funeral/'), funeralVariant);
    assert.equal(resolveVariant('/form2/corporate/'), corporateVariant);
    assert.equal(resolveVariant('/form2/catering-near-me/'), cateringNearMeVariant);
    assert.equal(resolveVariant('/form2/taco/'), tacoVariant);
  });

  it('uses canonical configuration steps while omitting only prefilled visible screens', () => {
    assert.deepEqual(bbqVariant.visibleSteps, ['guests', 'service', 'zip', 'phone', 'event_type', 'date', 'name']);
    assert.deepEqual(tacoVariant.visibleSteps, bbqVariant.visibleSteps);
    assert.deepEqual(cateringNearMeVariant.visibleSteps, bbqVariant.visibleSteps);
    assert.deepEqual(funeralVariant.visibleSteps, ['guests', 'service', 'zip', 'phone', 'date', 'name']);
    assert.deepEqual(corporateVariant.visibleSteps, funeralVariant.visibleSteps);
    assert.equal(funeralVariant.prefilledAnswers?.eventType, 'Memorial / Funeral');
    assert.equal(corporateVariant.prefilledAnswers?.eventType, 'Corporate');
  });

  it('routes completed BBQ leads to the dedicated V2 confirmation without query data', () => {
    const url = new URL(buildThankYouRedirectUrl(bbqVariant, attribution())!);
    assert.equal(url.pathname, '/form2/request-received/');
    assert.equal(url.search, '');
    assert.equal(url.pathname.includes('thank-you'), false);
  });

  it('uses the approved responsive BBQ hero derivatives', () => {
    assert.equal(bbqVariant.hero.image.status, 'approved');
    assert.equal(bbqVariant.hero.image.src, '/form2/assets/bbq-hero-desktop-v2.webp');
    assert.equal(bbqVariant.hero.image.mobileSrc, '/form2/assets/bbq-hero-mobile-v2.webp');
  });

  it('uses the approved responsive hero derivatives for every non-BBQ variant', () => {
    for (const [variant, slug] of [
      [funeralVariant, 'funeral'],
      [corporateVariant, 'corporate'],
      [cateringNearMeVariant, 'catering-near-me'],
      [tacoVariant, 'taco'],
    ] as const) {
      assert.equal(variant.hero.image.status, 'approved');
      assert.equal(variant.hero.image.src, `/form2/assets/${slug}-hero-desktop-v1.webp`);
      assert.equal(variant.hero.image.mobileSrc, `/form2/assets/${slug}-hero-mobile-v1.webp`);
    }
  });

  it('does not change the approved BBQ hero while activating first-party variant heroes', () => {
    for (const variant of [funeralVariant, corporateVariant, cateringNearMeVariant, tacoVariant]) {
      assert.notEqual(variant.hero.image.src, bbqVariant.hero.image.src);
      assert.notEqual(variant.hero.image.mobileSrc, bbqVariant.hero.image.mobileSrc);
    }
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
