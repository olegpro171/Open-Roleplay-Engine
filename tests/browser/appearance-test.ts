import { test as base, expect } from '@playwright/test';
import { appearanceSchema, appearanceStatusSchema, type Appearance, type AppearanceStatus } from '../../src/shared/appearance';

// Call after signing in. Only fields owned by this test are restored, so other
// shared settings are preserved even when the workflow fails partway through.
export const test = base.extend<{
  setAppearance: (settings: Partial<Appearance>) => Promise<AppearanceStatus>;
}>({
  setAppearance: async ({ page, baseURL }, use) => {
    const headers = { Origin: new URL(baseURL ?? page.url()).origin };
    const read = async () => {
      const response = await page.request.get('/api/application/appearance');
      expect(response.ok(), await response.text()).toBe(true);
      return appearanceStatusSchema.parse(await response.json());
    };
    const save = async (current: AppearanceStatus, settings: Partial<Appearance>) => {
      const response = await page.request.put('/api/application/appearance', {
        headers, data: { revision: current.revision, settings: { ...current.settings, ...settings } },
      });
      expect(response.ok(), await response.text()).toBe(true);
      return appearanceStatusSchema.parse(await response.json());
    };
    let original: Partial<Appearance> = {};
    try {
      await use(async settings => {
        await expect(page.getByRole('navigation', { name: 'Workspace', exact: true })).toBeVisible();
        const current = await read();
        for (const key of appearanceSchema.keyof().options) {
          if (key in settings && !(key in original)) original = { ...original, [key]: current.settings[key] };
        }
        const saved = await save(current, settings);
        await expect(page.locator('html')).toHaveAttribute('data-theme', saved.settings.theme);
        return saved;
      });
    } finally {
      if (Object.keys(original).length > 0) {
        const current = await read();
        const restored = await save(current, original);
        expect(restored.settings).toEqual({ ...current.settings, ...original });
      }
    }
  },
});
