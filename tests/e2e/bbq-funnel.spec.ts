import { expect, test } from '@playwright/test';

test('BBQ funnel completes and preserves state when going back', async ({ page }) => {
  await page.goto('/form2/bbq/');

  await expect(page.getByRole('heading', { name: /BBQ Catering/i })).toBeVisible();
  await expect(page.getByText('Step 1 of 7')).toBeVisible();

  await page.getByText('26–50', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('How would you like it served?')).toBeVisible();
  await page.getByText('Full Service', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Where is your event?')).toBeVisible();
  await page.getByLabel('Event ZIP code').fill('97205');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('What’s the best phone number to reach you?')).toBeVisible();
  const phone = page.getByLabel('Mobile number');
  await phone.fill('5035550123');
  await expect(phone).toHaveValue('(503) 555-0123');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('What kind of event is it?')).toBeVisible();

  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Mobile number')).toHaveValue('(503) 555-0123');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByText('Corporate', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('When is your event?')).toBeVisible();
  await page.getByText('Still deciding', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText(/Last step/i)).toBeVisible();
  await page.getByLabel('First name').fill('QA Test');
  await page.getByRole('button', { name: 'Finish' }).click();

  await expect(page.getByText('STAGING FLOW COMPLETE')).toBeVisible();
  await expect(page.getByText('Thanks, QA Test.')).toBeVisible();
  await expect(page.getByText('Corporate', { exact: true })).toBeVisible();
  await expect(page.getByText('97205', { exact: false })).toBeVisible();
});

test('layout never overflows horizontally', async ({ page }) => {
  await page.goto('/form2/bbq/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(overflow).toBeFalsy();
});
