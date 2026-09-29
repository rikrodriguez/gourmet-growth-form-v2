import { expect, Page, test } from '@playwright/test';

const deployedSha = process.env.E2E_BASE_URL ? process.env.GITHUB_SHA : undefined;
const funnelPath = `/form2/bbq/${deployedSha ? `?sha=${deployedSha}` : ''}`;

function option(page: Page, value: string) {
  return page.locator(`[data-option-value="${value}"]`);
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect.poll(() => page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  )).toBeTruthy();
}

async function chooseAndContinue(page: Page, value: string, nextStep: number) {
  const card = option(page, value);
  await card.click();
  await expect(card).toHaveClass(/is-selected/);
  await expect(card.locator('input[type="radio"]')).toBeChecked();

  const button = page.getByRole('button', { name: 'Continue' });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText(`Step ${nextStep} of 7`)).toBeVisible();
  await expectNoHorizontalOverflow(page);
}

async function reachPhoneStep(page: Page) {
  await chooseAndContinue(page, '26-50', 2);
  await chooseAndContinue(page, 'full-service', 3);
  await page.getByLabel('Event ZIP code').fill('97205');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  await expectNoHorizontalOverflow(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto(funnelPath);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
});

test('real card clicks advance once through the full funnel and Back preserves values', async ({ page }) => {
  const configuredLiveBuild = Boolean(process.env.E2E_BASE_URL);
  let unexpectedMainFrameNavigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) unexpectedMainFrameNavigations += 1;
  });

  await expect(page.getByRole('heading', { name: /BBQ Catering/i })).toBeVisible();
  await expect(page.getByText('Step 1 of 7')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await chooseAndContinue(page, '26-50', 2);
  await expect(page.getByText('Step 3 of 7')).toHaveCount(0);
  await chooseAndContinue(page, 'full-service', 3);

  await page.getByLabel('Event ZIP code').fill('97205');
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  const phone = page.getByLabel('Mobile number');
  await phone.fill('5035550123');
  await expect(phone).toHaveValue('(503) 555-0123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 5 of 7')).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  await expect(page.getByLabel('Mobile number')).toHaveValue('(503) 555-0123');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 5 of 7')).toBeVisible();

  await chooseAndContinue(page, 'Corporate', 6);
  await chooseAndContinue(page, 'still-deciding', 7);

  await page.getByLabel('First name').fill('QA Test');
  await expect(page.getByRole('button', { name: 'Finish' })).toBeEnabled();
  await page.getByRole('button', { name: 'Finish' }).click();

  await expect(page.getByText('REQUEST RECEIVED')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thank you, QA Test' })).toBeVisible();
  await expect(page.getByText('Corporate', { exact: true })).toBeVisible();
  if (configuredLiveBuild) {
    await expect(page).toHaveURL(/\/form2\/request-received\/$/);
    await expect(page.getByText('97205', { exact: false })).toHaveCount(0);
    expect(unexpectedMainFrameNavigations).toBeGreaterThanOrEqual(1);
  } else {
    await expect(page.getByText('97205', { exact: false })).toBeVisible();
    expect(unexpectedMainFrameNavigations).toBe(0);
  }
  await expectNoHorizontalOverflow(page);
});

test('ZIP fallback does not request the missing legacy dataset or block progression', async ({ page }) => {
  let legacyZipRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/bbq/cities/')) legacyZipRequests += 1;
  });
  await chooseAndContinue(page, '26-50', 2);
  await chooseAndContinue(page, 'full-service', 3);

  await page.getByLabel('Event ZIP code').fill('97205');
  await expect(page.getByText(/confirm service availability/i)).toBeVisible();
  await expect(page.locator('.zip-status-card .field-status-icon')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  expect(legacyZipRequests).toBe(0);
});

test('same-tab refresh preserves phone while local storage excludes PII', async ({ page, context }) => {
  await reachPhoneStep(page);
  await page.getByLabel('Mobile number').fill('5035550123');
  await expect(page.getByLabel('Mobile number')).toHaveValue('(503) 555-0123');

  await page.reload();
  await expect(page.getByText('Step 4 of 7')).toBeVisible();
  await expect(page.getByLabel('Mobile number')).toHaveValue('(503) 555-0123');

  const localStorageSnapshot = await page.evaluate(() => JSON.stringify(window.localStorage));
  expect(localStorageSnapshot).not.toContain('5035550123');
  expect(localStorageSnapshot).not.toContain('(503) 555-0123');
  expect(localStorageSnapshot).not.toContain('phone');
  expect(localStorageSnapshot).not.toContain('name');

  const secondTab = await context.newPage();
  await secondTab.goto(funnelPath);
  await expect(secondTab.getByText('Step 4 of 7')).toBeVisible();
  await expect(secondTab.getByLabel('Mobile number')).toHaveValue('');
});

test('Other event and Exact date conditional fields are required and usable', async ({ page }) => {
  await reachPhoneStep(page);
  await page.getByLabel('Mobile number').fill('5035550123');
  await page.getByRole('button', { name: 'Continue' }).click();

  await option(page, 'Other').click();
  await expect(page.getByLabel('Describe your event')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByLabel('Describe your event').fill('Anniversary');
  await page.getByRole('button', { name: 'Continue' }).click();

  await option(page, 'exact').click();
  await expect(page.locator('.date-grid .guest-option-icon')).toHaveCount(5);
  await expect(page.getByLabel('Event date')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  await page.getByLabel('Event date').fill('2099-12-31');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Step 7 of 7')).toBeVisible();
});

test('layout has no horizontal overflow on the initial viewport', async ({ page }) => {
  await expectNoHorizontalOverflow(page);
});

test('unregistered keyword routes never inherit the BBQ funnel', async ({ page }) => {
  await page.goto('/form2/unregistered/');
  await expect(page.getByRole('heading', { name: 'Growth Form V2' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /BBQ Catering/i })).toHaveCount(0);
});

test('dedicated confirmation route is a confirmation page with no acquisition form', async ({ page }) => {
  await page.goto('/form2/request-received/');
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect(page.getByText('REQUEST RECEIVED')).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  expect(page.url()).not.toContain('?');
  expect(page.url()).not.toContain('thank-you');
  await expectNoHorizontalOverflow(page);
});

test('retired Form 2 confirmation route moves to the new route before rendering the funnel', async ({ page }) => {
  await page.goto('/form2/thank-you/');
  await expect(page).toHaveURL(/\/form2\/request-received\/$/);
  await expect(page.getByText('REQUEST RECEIVED')).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
});

test('disabled previews are absent by default and visible only with explicit QA parameters', async ({ page }) => {
  await expect(page.locator('.exit-preview')).toHaveCount(0);
  await expect(page.locator('.social-proof-toast')).toHaveCount(0);

  await page.goto('/form2/bbq/?preview=exit-intent');
  await expect(page.getByRole('dialog', { name: /Need more time/i })).toBeVisible();

  await page.goto('/form2/bbq/?preview=social-proof');
  await expect(page.locator('.social-proof-toast')).toBeVisible();
});
