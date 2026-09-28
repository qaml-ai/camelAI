import { expect, gotoHydrated, test } from './base';

/**
 * Bypass-native UI-interaction E2E for the connections flow — fully local,
 * deterministic, no LLM or backend connection needed. Guards regressions like
 * #905 (connection setup form not dismissing): that buttons open/close dialogs
 * and that the setup form is dismissable.
 */
test.describe('connections (local, UI interactions)', () => {
  test('Add connection opens the dialog and Escape dismisses it', async ({ page }) => {
    await gotoHydrated(page, '/connections');
    await page.getByRole('button', { name: 'Add connection' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Add a connection')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('picking a connection type opens its setup form, and Cancel dismisses it', async ({
    page,
  }) => {
    await gotoHydrated(page, '/connections');
    await page.getByRole('button', { name: 'Add connection' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('PostgreSQL', { exact: false }).first().click();
    // The PostgreSQL setup form is shown. Regression #905: it must be dismissable.
    const cancel = dialog.getByRole('button', { name: 'Cancel' });
    await expect(cancel).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Create Connection' }),
    ).toBeVisible();
    await cancel.click();
    await expect(dialog).toBeHidden();
  });
});
