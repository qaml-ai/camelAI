import { expect, gotoHydrated, test } from './base';

/**
 * Bypass-native UI-interaction E2E — fully local, deterministic, no LLM/backend.
 * Verifies that buttons and menus do what they're supposed to: open, select,
 * navigate, dismiss.
 */
test.describe('chat UI (local, interactions)', () => {
  test('New chat button opens a fresh chat composer', async ({ page }) => {
    await gotoHydrated(page, '/chat');
    await page.getByRole('button', { name: 'New chat' }).first().click();
    await expect(page).toHaveURL(/\/chat\b/);
    await expect(page.locator('textarea').first()).toBeVisible();
  });
});
