import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const baseUrl = process.env.CAPTURE_BASE_URL ?? 'http://127.0.0.1:4173';
const outputDir = new URL('../artifacts/m4b2/', import.meta.url);
const variants = ['bbq', 'funeral', 'corporate', 'catering-near-me', 'taco'];
const viewports = [
  { width: 390, height: 844 },
  { width: 412, height: 915 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];

await mkdir(outputDir, { recursive: true });

async function cleanOpen(page, variant) {
  await page.goto(`${baseUrl}/form2/${variant}/`);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page.reload();
}

async function captureSkipScreen(page, variant) {
  await cleanOpen(page, variant);
  await page.locator('[data-option-value="26-50"]').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('[data-option-value="full-service"]').click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Event ZIP code').fill('97205');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Mobile number').fill('5035550123');
  await page.getByRole('button', { name: 'Continue' }).click();
}

const browser = await chromium.launch();
try {
  for (const viewport of viewports) {
    for (const variant of variants) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      await cleanOpen(page, variant);
      await page.screenshot({
        path: fileURLToPath(new URL(`${variant}-${viewport.width}x${viewport.height}-first.png`, outputDir)),
        animations: 'disabled',
      });
      await page.close();
    }
  }

  for (const variant of ['funeral', 'corporate']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    await captureSkipScreen(page, variant);
    await page.screenshot({
      path: fileURLToPath(new URL(`${variant}-390x844-post-phone-skip-event-type.png`, outputDir)),
      animations: 'disabled',
    });
    await page.close();
  }
} finally {
  await browser.close();
}
