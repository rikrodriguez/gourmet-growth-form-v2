import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { captureVisibleVoice } from './capture.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_PATH ||
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
const authorized = { authorized: true, confirmedAt: '2026-10-28T12:00:00.000Z' };
const style = `<style>
  body { margin: 0; font: 16px sans-serif; }
  aside { position: absolute; left: 0; top: 0; width: 150px; }
  gv-text-thread { display: block; margin-left: 180px; width: 320px; }
  gv-text-thread-item { display: block; padding: 12px; margin: 8px; border: 1px solid; }
</style>`;
let count = 0;
async function check(name, run) {
  await run(); count += 1; console.log(`ok ${count} - ${name}`);
}
async function fixture(html, url = 'https://voice.google.com/u/0/messages') {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: `${style}${html}` }));
  await page.goto(url);
  return page;
}
async function capture(page, options = {}) {
  return page.evaluate(captureVisibleVoice, { ...authorized, ...options });
}
async function popup() {
  const page = await browser.newPage({ acceptDownloads: true });
  await page.route('**/*', async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const types = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
    const contentType = types[name.split('.').pop()];
    if (!contentType || !/^[a-z.-]+$/.test(name)) return route.abort();
    await route.fulfill({ contentType, body: await fs.readFile(`${directory}${name}`) });
  });
  await page.addInitScript(() => {
    window.calls = [];
    window.chrome = {
      tabs: { query: async () => { window.calls.push('query'); return [{ id: 1, url: 'https://voice.google.com/u/0/messages' }]; } },
      scripting: {
        executeScript: async (options) => {
          window.calls.push(options);
          const context = {
            schemaVersion: 1, source: 'google-voice', capturedAt: '2026-10-28T12:01:00.000Z',
            captureMode: options.args[0].captureMode, historyComplete: false,
            authorization: { captureConfirmed: true, confirmedAt: options.args[0].confirmedAt },
            text: 'Reserva por confirmar', warnings: ['Historial incompleto.']
          };
          if (window.deferCapture) await new Promise((resolve) => { window.finishCapture = resolve; });
          return [{ result: { ok: true, context } }];
        }
      }
    };
  });
  await page.goto('https://extension.test/popup.html');
  await page.locator('#capture').waitFor();
  return page;
}

try {
  await check('manifest has only explicit temporary permissions and forbids network', async () => {
    const manifest = JSON.parse(await fs.readFile(`${directory}manifest.json`, 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
    for (const key of ['host_permissions', 'content_scripts', 'background', 'optional_permissions']) assert.equal(manifest[key], undefined);
    assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
  });
  await check('capture needs authorization and correct origin before any DOM read', async () => {
    const page = await fixture('<gv-text-thread><gv-text-thread-item>Secret</gv-text-thread-item></gv-text-thread>');
    await page.evaluate(() => { document.querySelectorAll = () => { throw new Error('Unexpected DOM read'); }; });
    assert.equal((await capture(page, { authorized: false })).ok, false);
    await page.close();
    const wrong = await fixture('<gv-text-thread>Secret</gv-text-thread>', 'https://example.test');
    assert.equal((await capture(wrong)).ok, false);
    await wrong.close();
  });
  await check('only current thread text, no inbox, composer, hidden or offscreen messages', async () => {
    const page = await fixture(`<aside>INBOX OTHER CLIENT</aside><gv-text-thread>
      <gv-text-thread-item>Visible reservation <span hidden>HIDDEN</span><button>CONTROL</button></gv-text-thread-item>
      <gv-text-thread-item style="display:none">HIDDEN BUBBLE</gv-text-thread-item>
      <gv-text-thread-item style="opacity:0">TRANSPARENT</gv-text-thread-item>
      <gv-text-thread-item style="position:absolute;top:700px">OFFSCREEN</gv-text-thread-item>
      <textarea>DRAFT</textarea>
    </gv-text-thread>`);
    const result = await capture(page);
    assert.equal(result.ok, true);
    assert.equal(result.context.text, 'Visible reservation');
    assert.equal(result.context.historyComplete, false);
    assert.equal(result.context.authorization.captureConfirmed, true);
    assert.equal(result.context.source, 'google-voice');
    assert.equal(result.context.schemaVersion, 1);
    assert.ok(Number.isFinite(Date.parse(result.context.capturedAt)));
    await page.close();
  });
  await check('partially clipped bubbles and hidden clipped text are omitted', async () => {
    const page = await fixture(`<gv-text-thread style="height:100px;overflow:hidden">
      <gv-text-thread-item>Visible</gv-text-thread-item>
      <gv-text-thread-item style="height:100px">CLIPPED BUBBLE</gv-text-thread-item>
    </gv-text-thread>`);
    assert.equal((await capture(page)).context.text, 'Visible');
    await page.setContent(`${style}<gv-text-thread><gv-text-thread-item>Visible <span style="display:inline-block;width:1px;height:1px;overflow:hidden">HIDDEN CLIPPED TEXT</span></gv-text-thread-item></gv-text-thread>`);
    assert.equal((await capture(page)).context.text, 'Visible');
    await page.close();
  });
  await check('covered messages are omitted', async () => {
    const page = await fixture(`<gv-text-thread><gv-text-thread-item>Covered secret</gv-text-thread-item></gv-text-thread>
      <div style="position:fixed;inset:0;background:white;z-index:10">Modal</div>`);
    assert.equal((await capture(page)).ok, false);
    await page.close();
  });
  await check('unknown and multiple conversation roots fail closed', async () => {
    for (const html of [
      '<main>Unknown DOM secret</main>',
      '<gv-text-thread><gv-text-thread-item>A</gv-text-thread-item></gv-text-thread><gv-text-thread><gv-text-thread-item>B</gv-text-thread-item></gv-text-thread>',
      '<gv-text-thread><gv-text-thread><gv-text-thread-item>Nested ambiguity</gv-text-thread-item></gv-text-thread></gv-text-thread>'
    ]) {
      const page = await fixture(html);
      assert.equal((await capture(page)).ok, false);
      await page.close();
    }
  });
  await check('selection is explicit, restricted to conversation and clipped to selected offsets', async () => {
    const page = await fixture('<aside>Other client</aside><gv-text-thread><span id="selection">Before SELECTED after</span></gv-text-thread>');
    assert.equal((await capture(page, { captureMode: 'selection' })).ok, false);
    await page.evaluate(() => {
      const text = document.querySelector('#selection').firstChild;
      const range = document.createRange(); range.setStart(text, 7); range.setEnd(text, 15);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    const result = await capture(page, { captureMode: 'selection' });
    assert.equal(result.context.text, 'SELECTED');
    assert.equal(result.context.captureMode, 'selection');
    assert.equal(result.context.historyComplete, false);
    await page.evaluate(() => {
      const range = document.createRange(); range.selectNodeContents(document.body);
      window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    assert.equal((await capture(page, { captureMode: 'selection' })).ok, false);
    await page.close();
  });
  await check('popup does not read until authorized click, then requires review to export', async () => {
    const page = await popup();
    assert.equal(await page.locator('#capture').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await page.locator('#authorize').check();
    assert.equal(await page.evaluate(() => window.calls.length), 0);
    await page.locator('#capture').click();
    await page.locator('#preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.locator('#reviewed').check();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await downloadPromise;
    const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.equal(exported.historyComplete, false);
    assert.equal(exported.authorization.captureConfirmed, true);
    assert.equal(exported.text, 'Reserva por confirmar');
    await page.locator('#context').fill('Reserva corregida');
    assert.equal(await page.locator('#reviewed').isChecked(), false);
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.locator('#reviewed').check();
    const editedDownload = page.waitForEvent('download');
    await page.locator('#export').click();
    const edited = JSON.parse(await fs.readFile(await (await editedDownload).path(), 'utf8'));
    assert.equal(edited.text, 'Reserva corregida');
    assert.equal(edited.historyComplete, false);
    assert.ok(edited.warnings.some((warning) => warning.includes('editado')));
    await page.locator('#authorize').uncheck();
    assert.equal(await page.locator('#context').inputValue(), '');
    assert.equal(await page.locator('#preview').isHidden(), true);
    await page.close();
  });
  await check('revoking authorization during capture discards the delayed response', async () => {
    const page = await popup();
    await page.evaluate(() => { window.deferCapture = true; });
    await page.locator('#authorize').check();
    await page.locator('#capture').click();
    await page.waitForFunction(() => window.finishCapture);
    await page.locator('#authorize').uncheck();
    await page.evaluate(() => window.finishCapture());
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('retirada'));
    assert.equal(await page.locator('#context').inputValue(), '');
    assert.equal(await page.locator('#preview').isHidden(), true);
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.close();
  });
  await check('evidence UI updates edits safely and keeps missing fields and conflicts unconfirmed', async () => {
    const page = await popup();
    await page.locator('#authorize').check();
    await page.locator('#capture').click();
    await page.locator('#preview').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#evidence-rows tr[data-status="missing"]').count(), 6);
    const text = 'Nombre del cliente: <img src=x onerror=alert(1)>\nTotal acordado: USD 1000.00\nTotal acordado: $1200 USD\nFecha: 12/10';
    await page.locator('#context').fill(text);
    const total = page.locator('#evidence-rows tr[data-field="agreedTotal"]');
    assert.equal(await total.getAttribute('data-status'), 'conflict');
    assert.equal(await total.locator('blockquote').count(), 2);
    assert.match(await total.innerText(), /Última aparición en este extracto; no prueba el último acuerdo/);
    assert.equal(await page.locator('#evidence-rows tr[data-field="eventDate"]').getAttribute('data-status'), 'missing');
    assert.equal(await page.locator('#evidence img').count(), 0);
    assert.equal(await page.locator('#evidence-rows tr[data-field="customerName"] strong').textContent(), '<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('#export').isDisabled(), true);
    await page.locator('#context').fill('Total acordado: USD 900');
    assert.equal(await total.getAttribute('data-status'), 'candidate');
    assert.equal(await total.locator('strong').textContent(), '900.00');
    await page.locator('#context').fill('Total acordado: USD 900\nTotal acordado: por confirmar\nDepósito: 250 USD\nDepósito: por confirmar\nMoneda: EUR');
    for (const name of ['agreedTotal', 'depositAmount', 'currency']) {
      const row = page.locator(`#evidence-rows tr[data-field="${name}"]`);
      assert.equal(await row.getAttribute('data-status'), 'conflict');
      assert.equal(await row.getAttribute('data-unresolved-update'), 'true');
      assert.match(await row.locator('.unresolved-update').innerText(), /Los valores anteriores no se consideran vigentes/);
      assert.doesNotMatch((await row.locator('.candidate').allInnerTexts()).join('\n'), /Última aparición/);
    }
    assert.equal(await total.locator('.unresolved-update blockquote').textContent(), 'Total acordado: por confirmar');
    await page.locator('#context').fill('Total acordado: USD 900\nTotal acordado: por confirmar\nTotal acordado: USD 1000');
    assert.equal(await total.getAttribute('data-status'), 'conflict');
    assert.equal(await total.getAttribute('data-unresolved-update'), null);
    assert.equal(await total.locator('.unresolved-update').count(), 0);
    await page.close();
  });
  console.log(`Passed ${count} extension checks; synthetic DOM only, no live Voice access.`);
} finally {
  await browser.close();
}
