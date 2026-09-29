import { expect, Page, test } from '@playwright/test';

type VariantCase = {
  slug: string;
  headline: RegExp;
  visibleSteps: number;
  mobileHeroAsset: string;
  desktopHeroAsset: string;
  prefilledEventType?: 'Corporate' | 'Memorial / Funeral';
};

const variants: readonly VariantCase[] = [
  { slug: 'bbq', headline: /BBQ Catering/i, visibleSteps: 7, mobileHeroAsset: 'bbq-hero-mobile-v2.webp', desktopHeroAsset: 'bbq-hero-desktop-v2.webp' },
  { slug: 'funeral', headline: /Thoughtful Catering/i, visibleSteps: 6, mobileHeroAsset: 'funeral-hero-mobile-v1.webp', desktopHeroAsset: 'funeral-hero-desktop-v1.webp', prefilledEventType: 'Memorial / Funeral' },
  { slug: 'corporate', headline: /Corporate Catering/i, visibleSteps: 6, mobileHeroAsset: 'corporate-hero-mobile-v1.webp', desktopHeroAsset: 'corporate-hero-desktop-v1.webp', prefilledEventType: 'Corporate' },
  { slug: 'catering-near-me', headline: /Catering for/i, visibleSteps: 7, mobileHeroAsset: 'catering-near-me-hero-mobile-v1.webp', desktopHeroAsset: 'catering-near-me-hero-desktop-v1.webp' },
  { slug: 'taco', headline: /Taco Catering/i, visibleSteps: 7, mobileHeroAsset: 'taco-hero-mobile-v1.webp', desktopHeroAsset: 'taco-hero-desktop-v1.webp' },
];

function pathFor(slug: string) {
  const sha = process.env.E2E_BASE_URL ? process.env.GITHUB_SHA : undefined;
  return `/form2/${slug}/${sha ? `?sha=${sha}` : ''}`;
}

async function cleanOpen(page: Page, slug: string) {
  await page.goto(pathFor(slug));
  await page.evaluate(() => { window.localStorage.clear(); window.sessionStorage.clear(); });
  await page.goto(pathFor(slug));
  await page.waitForFunction(() => Boolean(window.__GOURMET_TELEMETRY_DEBUG__));
}

async function selectAndContinue(page: Page, value: string) {
  await page.locator(`[data-option-value="${value}"]`).click();
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function completeVariant(page: Page, variant: VariantCase) {
  await selectAndContinue(page, '26-50');
  await selectAndContinue(page, 'full-service');
  await page.getByLabel('Event ZIP code').fill('97205');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Mobile number').fill('5035550123');
  await page.getByRole('button', { name: 'Continue' }).click();

  if (!variant.prefilledEventType) await selectAndContinue(page, 'Corporate');

  await selectAndContinue(page, 'still-deciding');
  await page.getByLabel('First name').fill('QA Variant');
  await page.getByRole('button', { name: 'Finish' }).click();
}

for (const variant of variants) {
  test(`${variant.slug} resolves with its configured intent, visible progress, and responsive surface`, async ({ page }, testInfo) => {
    await cleanOpen(page, variant.slug);
    await expect(page.getByRole('heading', { name: variant.headline })).toBeVisible();
    await expect(page.getByText(`Step 1 of ${variant.visibleSteps}`)).toBeVisible();
    await expect(page.locator('.bbq-hero')).toHaveClass(/has-hero-image/);
    const heroAsset = /tablet|desktop/.test(testInfo.project.name)
      ? variant.desktopHeroAsset
      : variant.mobileHeroAsset;
    await expect(page.locator('.bbq-hero')).toHaveCSS('background-image', new RegExp(heroAsset.replace('.', '\\.')));
    await expect(page.locator('.exit-preview, .social-proof-toast')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
    const telemetry = await page.evaluate(() => window.__GOURMET_TELEMETRY_DEBUG__!.getSnapshot());
    expect(telemetry.events[0]).toMatchObject({ intent_cluster: variant.slug, step_id: 'guests', step_index: 1 });
  });

  test(`${variant.slug} follows its visible steps without renumbering telemetry`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium-390x844', 'Detailed variant navigation is sampled once; route rendering is checked at every viewport.');
    await cleanOpen(page, variant.slug);
    await selectAndContinue(page, '26-50');
    await selectAndContinue(page, 'full-service');
    await page.getByLabel('Event ZIP code').fill('97205');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText(`Step 4 of ${variant.visibleSteps}`)).toBeVisible();
    await page.getByLabel('Mobile number').fill('5035550123');
    await page.getByRole('button', { name: 'Continue' }).click();

    if (variant.prefilledEventType) {
      await expect(page.getByText(`Step 5 of ${variant.visibleSteps}`)).toBeVisible();
      await expect(page.getByRole('group', { name: /What kind of event/i })).toHaveCount(0);
      const events = await page.evaluate(() => window.__GOURMET_TELEMETRY_DEBUG__!.getSnapshot().events);
      expect(events.some((event) => event.step_id === 'event_type')).toBeFalsy();
      await page.getByRole('button', { name: 'Back' }).click();
      await expect(page.getByText(`Step 4 of ${variant.visibleSteps}`)).toBeVisible();
      await page.reload();
      await expect(page.getByText(`Step 4 of ${variant.visibleSteps}`)).toBeVisible();
      return;
    }

    await expect(page.getByText(`Step 5 of ${variant.visibleSteps}`)).toBeVisible();
    await expect(page.getByRole('group', { name: /What kind of event/i })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText(`Step 4 of ${variant.visibleSteps}`)).toBeVisible();
    await page.reload();
    await expect(page.getByText(`Step 4 of ${variant.visibleSteps}`)).toBeVisible();
  });

  test(`${variant.slug} retains its intent through lead capture and the shared confirmation`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium-390x844', 'Completion behavior is sampled once; route rendering is checked at every viewport.');
    await cleanOpen(page, variant.slug);
    await completeVariant(page, variant);

    if (process.env.E2E_BASE_URL) {
      await expect(page).toHaveURL(/\/form2\/request-received\/$/);
    }
    await expect(page.getByText('REQUEST RECEIVED')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Thank you, QA Variant' })).toBeVisible();
    await expect(page.getByText(variant.prefilledEventType ?? 'Corporate', { exact: true })).toBeVisible();
  });
}
