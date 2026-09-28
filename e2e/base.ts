import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared base for the local E2E specs. Holds the final frame for ~1s after each
 * test so the recorded videos don't cut off abruptly on the last action.
 */
export const test = base;

test.afterEach(async ({ page }) => {
  await page.waitForTimeout(1000).catch(() => {});
});

export { expect };

/**
 * Open `path` and wait until React has hydrated it: the app's loading overlay
 * (AppLoadingOverlay) is removed only by a client effect after hydration. A
 * click on the server-rendered markup before that does nothing, and
 * `networkidle` never arrives while the page holds its status stream open.
 */
export async function gotoHydrated(page: Page, path: string) {
  const overlay = page.locator('[data-app-loading-overlay]');
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  try {
    await expect(overlay).toHaveCount(0, { timeout: 20_000 });
  } catch {
    // A cold Vite server can invalidate its first optimized dependency request,
    // and that page never hydrates: load it again once optimization settles.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(overlay).toHaveCount(0, { timeout: 30_000 });
  }
}
