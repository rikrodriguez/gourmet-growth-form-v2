import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const baseUrl = process.env.CAPTURE_BASE_URL ?? 'http://127.0.0.1:4173';
const outputDir = new URL('../artifacts/m4a1/', import.meta.url);
await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch();

async function cleanFunnel(page, suffix = '') {
  await page.goto(`${baseUrl}/form2/bbq/${suffix}`);
  await page.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.localStorage.setItem('gourmet_growth_measurement_consent_v1', JSON.stringify({
      version: 1,
      updated_at: new Date().toISOString(),
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    }));
  });
  await page.reload();
}

async function shot(page, name) {
  await page.screenshot({ path: fileURLToPath(new URL(name, outputDir)), animations: 'disabled' });
}

async function select(page, value) {
  await page.locator(`[data-option-value="${value}"]`).click();
}

async function next(page) {
  await page.getByRole('button', { name: 'Continue' }).click();
}

async function captureMobileFlow() {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  await cleanFunnel(page);
  await shot(page, '390-guests-unselected.png');
  await select(page, '10-25');
  await shot(page, '390-guests-selected.png');
  await next(page);
  await shot(page, '390-service.png');
  await select(page, 'full-service');
  await next(page);
  await page.getByLabel('Event ZIP code').fill('97205');
  await shot(page, '390-zip.png');
  await next(page);
  await page.getByLabel('Mobile number').fill('5035550123');
  await shot(page, '390-phone.png');
  await next(page);
  await select(page, 'Corporate');
  await shot(page, '390-event-type.png');
  await next(page);
  await select(page, 'still-deciding');
  await shot(page, '390-date.png');
  await next(page);
  await page.getByLabel('First name').fill('Ricardo');
  await shot(page, '390-name.png');

  await page.goto(`${baseUrl}/form2/request-received/`);
  await page.evaluate(() => sessionStorage.setItem('gourmet_growth_v2_completion_v1', JSON.stringify({
    version: 1,
    completedAt: Date.now(),
    variant: 'bbq',
    firstName: 'Ricardo',
    eventType: 'Corporate',
    guests: '10-25',
    service: 'full-service',
    timing: 'still-deciding',
  })));
  await page.reload();
  await shot(page, '390-request-received.png');

  await cleanFunnel(page, '?preview=exit-intent');
  await shot(page, '390-exit-intent-preview.png');
  await cleanFunnel(page, '?preview=social-proof');
  await shot(page, '390-social-proof-preview.png');
  await page.close();
}

async function captureResponsive(width, height, label) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await cleanFunnel(page);
  await shot(page, `${label}-first.png`);
  await select(page, '26-50');
  await next(page);
  await select(page, 'full-service');
  await next(page);
  await page.getByLabel('Event ZIP code').fill('97205');
  await shot(page, `${label}-mid.png`);
  await page.goto(`${baseUrl}/form2/request-received/`);
  await shot(page, `${label}-request-received.png`);
  await page.close();
}

try {
  await captureMobileFlow();
  await captureResponsive(768, 1024, 'tablet-768x1024');
  await captureResponsive(1024, 768, 'tablet-1024x768');
  await captureResponsive(1440, 900, 'desktop-1440x900');
} finally {
  await browser.close();
}
