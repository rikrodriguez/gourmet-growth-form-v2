// Optional native MV3 smoke check. This is separate from synthetic capture tests
// because an administrator can prohibit unpacked extensions in the test browser.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const path = fileURLToPath(new URL('.', import.meta.url));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH ||
  (existsSync('/usr/lib/chromium/chromium') ? '/usr/lib/chromium/chromium' :
    existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const profile = await fs.mkdtemp('/tmp/voice-context-native-');
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--no-sandbox', '--enable-unsafe-extension-debugging']
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  assert.equal(await page.locator('#capture').isDisabled(), true);
  const native = await page.evaluate(() => ({
    manifestVersion: chrome.runtime.getManifest().manifest_version,
    tabsQuery: typeof chrome.tabs.query,
    executeScript: typeof chrome.scripting.executeScript
  }));
  assert.deepEqual(native, { manifestVersion: 3, tabsQuery: 'function', executeScript: 'function' });
  console.log('PASS: native MV3 popup loaded; Chrome tabs/scripting APIs available. No Voice session accessed.');
} catch (error) {
  console.error(`Native MV3 check could not complete: ${error.message}`);
  console.error('No browser policies, account permissions or credentials were changed.');
  process.exitCode = 2;
} finally {
  await context?.close();
  await fs.rm(profile, { recursive: true, force: true });
}
