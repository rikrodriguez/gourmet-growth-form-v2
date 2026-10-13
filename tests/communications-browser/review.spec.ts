import { test, expect, type Page } from '@playwright/test';

// Real Vite UI → real guarded HTTP → real workflow → encrypted isolated PG.
// No route.fulfill(), fixed API responses, provider clients or real identities.
async function open(page: Page) {
  await page.goto('/office/communications');
  await page.getByRole('button', { name: 'Iniciar sesión local de prueba' }).click();
  await expect(page.getByRole('region', { name: 'Sesión y almacenamiento' })).toBeVisible();
}
async function bind(page: Page, index = 0) {
  await page.getByRole('radio').nth(index).check();
  await page.getByLabel('Evidencia de tu revisión').fill('fixture:revisión humana del contexto exacto');
  await page.getByRole('checkbox', { name: 'He revisado las fuentes y la evidencia de este lead, evento, cuenta e hilo.' }).check();
  const ambiguity = page.getByRole('checkbox', { name: 'Reconozco las varias coincidencias y elijo explícitamente esta combinación.' });
  if (await ambiguity.count()) await ambiguity.check();
  await page.getByRole('button', { name: 'Guardar vínculo explícito' }).click();
  await expect(page.getByRole('button', { name: 'Crear borrador' })).toBeEnabled();
}
async function save(page: Page, body = 'Respuesta sintética exacta para revisión.', html?: string) {
  await page.getByRole('button', { name: 'Crear borrador' }).click();
  await page.getByLabel('Texto del mensaje', { exact: true }).fill(body);
  if (html) { await page.getByLabel('Incluir HTML exacto como código').check(); await page.getByLabel('HTML del mensaje (no se renderiza)').fill(html); }
  await page.getByRole('button', { name: 'Guardar revisión exacta' }).click();
  await expect(page.getByTestId('communications-saved-draft')).toBeVisible();
  await expect(page.getByTestId('communications-draft-text')).toHaveText(body);
}
async function review(page: Page) {
  await page.getByRole('button', { name: 'Verificar revisión guardada' }).click();
  const consent = page.getByRole('checkbox', { name: /He revisado el contenido exacto de la revisión/ });
  await expect(consent).toBeEnabled(); await consent.check();
}

test('explicit account/lead review precedes exact approval; repeated approval cannot add another outbox entry', async ({ page }) => {
  await open(page); await expect(page.getByRole('region', { name: 'Buzones separados' })).toContainText('felipe@example.test'); await expect(page.getByRole('region', { name: 'Buzones separados' })).toContainText('info@example.test');
  await page.getByRole('radio').first().check(); await expect(page.getByRole('button', { name: 'Guardar vínculo explícito' })).toBeDisabled();
  await bind(page); await save(page); const approve = page.getByRole('button', { name: 'Aprobar revisión 1 sin enviar' }); await expect(approve).toBeDisabled();
  await review(page); await approve.click(); await expect(page.getByTestId('communications-outbox-item')).toHaveCount(1); await expect(page.getByTestId('communications-outbox-item')).toContainText('approved_unsent'); await expect(approve).toBeDisabled();
  await page.reload(); await expect(page.getByTestId('communications-outbox-item')).toHaveCount(1);
});

test('cancel editing retains saved content and clears approval consent; saved revision invalidates old approval', async ({ page }) => {
  await open(page); await bind(page); await save(page); await review(page); await page.getByRole('button', { name: 'Aprobar revisión 1 sin enviar' }).click();
  await page.getByRole('button', { name: 'Editar borrador' }).click(); await page.getByLabel('Texto del mensaje', { exact: true }).fill('Edición cancelada'); await page.getByRole('button', { name: 'Cancelar edición' }).click();
  await expect(page.getByTestId('communications-draft-text')).toHaveText('Respuesta sintética exacta para revisión.');
  await page.getByRole('button', { name: 'Editar borrador' }).click(); await page.getByLabel('Texto del mensaje', { exact: true }).fill('Segunda revisión exacta'); await page.getByRole('button', { name: 'Guardar revisión exacta' }).click();
  await expect(page.getByTestId('communications-outbox-item')).toContainText('stale'); await expect(page.getByRole('button', { name: 'Aprobar revisión 2 sin enviar' })).toBeDisabled();
  await review(page); await page.getByRole('button', { name: 'Aprobar revisión 2 sin enviar' }).click(); await expect(page.getByTestId('communications-outbox-item')).toHaveCount(2);
});

test('HTML remains inert exact source and does not request external assets', async ({ page }) => {
  const external: string[] = []; page.on('request', request => { if (new URL(request.url()).hostname === 'example.test') external.push(request.url()); });
  await open(page); await bind(page); const html = '<img src="https://example.test/never-load" onerror="window.fixtureInjected=true"><script>window.fixtureInjected=true</script>';
  await save(page, '<script>Texto visible, no ejecutable</script>', html);
  await expect(page.getByTestId('communications-draft-html')).toHaveText(html); await expect(page.getByTestId('communications-saved-draft').locator('script,img,iframe')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).fixtureInjected)).toBeUndefined(); expect(external).toEqual([]);
});

test('selected-thread outgoing uncertainty blocks followup while a separate complete fixture can prepare one', async ({ page }) => {
  await open(page); await bind(page); await page.getByRole('button', { name: 'Crear borrador' }).click();
  await expect(page.getByLabel('Propósito').locator('option[value="follow_up"]')).toBeDisabled(); await page.getByRole('button', { name: 'Cancelar edición' }).click();
  await bind(page, 2); await page.getByRole('button', { name: 'Crear borrador' }).click(); await page.getByLabel('Propósito').selectOption('follow_up');
  await page.getByLabel('Texto del mensaje', { exact: true }).fill('Seguimiento sintético con cobertura completa'); await page.getByRole('button', { name: 'Guardar revisión exacta' }).click(); await expect(page.getByTestId('communications-saved-draft')).toContainText('Seguimiento');
});

test('logout clears approval authority and next session is a fresh isolated fixture', async ({ page }) => {
  await open(page); await bind(page); await save(page); await review(page); await page.getByRole('button', { name: 'Cerrar sesión local' }).click();
  await expect(page.getByRole('button', { name: 'Iniciar sesión local de prueba' })).toBeVisible(); await page.getByRole('button', { name: 'Iniciar sesión local de prueba' }).click();
  await expect(page.getByTestId('communications-saved-draft')).toHaveCount(0); await expect(page.getByTestId('communications-outbox-item')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Crear borrador' })).toBeDisabled();
});

test('concurrent tabs require a new read and exact review after another tab changes the draft', async ({ page, context }) => {
  await open(page); await bind(page); await save(page); await review(page);
  const second = await context.newPage(); await second.goto('/office/communications'); await second.getByLabel('Revisión guardada', { exact: true }).selectOption({ index: 1 }); await second.getByRole('button', { name: 'Editar borrador' }).click(); await second.getByLabel('Texto del mensaje', { exact: true }).fill('Cambio en otra pestaña'); await second.getByRole('button', { name: 'Guardar revisión exacta' }).click();
  await expect(second.getByTestId('communications-draft-text')).toHaveText('Cambio en otra pestaña'); await page.bringToFront();
  await expect(page.getByRole('checkbox', { name: /He revisado el contenido exacto de la revisión/ })).not.toBeChecked(); await page.getByRole('button', { name: 'Verificar revisión guardada' }).click();
  await expect(page.getByTestId('communications-outbox-item')).toHaveCount(0); await expect(page.getByRole('alert').first()).toBeVisible(); await expect(page.getByRole('button', { name: 'Aprobar revisión 1 sin enviar' })).toBeDisabled(); await second.close();
});

test('separate browser sessions do not inherit another actor drafts or decisions', async ({ page, browser }) => {
  await open(page); await bind(page); await save(page); const secondContext = await browser.newContext();
  try { const second = await secondContext.newPage(); await second.goto('http://127.0.0.1:4175/office/communications'); await second.getByRole('button', { name: 'Iniciar sesión local de prueba' }).click(); await expect(second.getByRole('button', { name: 'Crear borrador' })).toBeDisabled(); await expect(second.getByTestId('communications-saved-draft')).toHaveCount(0); }
  finally { await secondContext.close(); }
});

test('leaving and returning cannot carry approval consent across navigation', async ({ page }) => {
  await open(page); await bind(page); await save(page); await review(page); await page.getByRole('link', { name: 'Volver a la oficina' }).click(); await page.goBack();
  await expect(page.getByRole('region', { name: 'Sesión y almacenamiento' })).toBeVisible();
  await page.getByLabel('Revisión guardada', { exact: true }).selectOption({ index: 1 }); await expect(page.getByRole('checkbox', { name: /He revisado el contenido exacto de la revisión/ })).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Aprobar revisión 1 sin enviar' })).toBeDisabled();
});
