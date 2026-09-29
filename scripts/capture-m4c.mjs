import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const baseUrl = process.env.CAPTURE_BASE_URL ?? 'http://127.0.0.1:4173';
const outputDir = new URL('../artifacts/m4c/', import.meta.url);
const experimentId = 'bbq-first-screen-density-v1';
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const variant of ['control', 'compact-first-screen']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    const query = `?experiment_preview=${experimentId}&experiment_variant=${variant}`;
    await page.goto(`${baseUrl}/form2/bbq/${query}`);
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.localStorage.setItem('gourmet_growth_measurement_consent_v1', JSON.stringify({
        version: 1,
        updated_at: new Date().toISOString(),
        analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied',
      }));
    });
    await page.reload();
    await page.screenshot({
      path: fileURLToPath(new URL(`${variant}-390x844.png`, outputDir)), animations: 'disabled',
    });
    await page.close();
  }
} finally {
  await browser.close();
}
