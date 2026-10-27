import { expect, type Locator } from '@playwright/test';
import { test } from './isolated-app';
import type { LibrarySnapshot } from '../../src/shared/library';

test.use({ hasTouch: true });

for (const [width, input] of [[1280, 'mouse'], [390, 'touch'], [320, 'mouse']] as const) {
  test(`outside ${input} activation only dismisses tag filters at ${width}px`, async ({ page, browserApp }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const headers = { Origin: browserApp.url };
    const readLibrary = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
    const tag = await page.request.post('/api/library/tags', { headers, data: { revision: (await readLibrary()).revision, name: 'Dismissal tag' } });
    expect(tag.ok()).toBe(true);
    const library = await readLibrary();
    const saved = await page.request.post('/api/library', { headers, data: {
      revision: library.revision, kind: 'characters', tagIds: library.tags.map(tag => tag.id),
      data: { name: 'Dismissal character', description: 'A character that must stay closed when dismissing tags.', personality: '', scenario: '', first_mes: '', mes_example: '' },
    } });
    expect(saved.ok()).toBe(true);
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    const trigger = page.getByRole('button', { name: /^Tags/ });
    const panel = page.locator('.tag-filter-panel');
    const card = page.getByRole('article');
    await expect(card).toHaveCount(1);

    async function activateOutside(target: Locator, left = false) {
      const bounds = await target.boundingBox();
      const popup = await panel.boundingBox();
      if (!bounds || !popup) throw new Error('Missing outside target or popup');
      const x = left ? bounds.x + 24 : bounds.x + bounds.width / 2;
      const y = bounds.y + bounds.height / 2;
      expect(x < popup.x || x > popup.x + popup.width || y < popup.y || y > popup.y + popup.height).toBe(true);
      // Real pointer coordinates exercise the dismissing surface rather than
      // bypassing hit testing to dispatch directly to a covered control.
      if (input === 'touch') await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
    }

    await trigger.click();
    await panel.getByRole('checkbox', { name: 'Dismissal tag', exact: true }).check();
    await activateOutside(card, true);
    await expect(panel).toHaveCount(0);
    await expect(page.getByLabel('Character description', { exact: true })).toHaveCount(0);
    await expect(card).toHaveCount(1);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole('group', { name: 'Active tag filters' })).toContainText('Dismissal tag');
    // A subsequent intentional click still opens the editor normally.
    await card.getByRole('heading').getByRole('button').click();
    await expect(page.getByLabel('Character description', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await trigger.click();
    await panel.getByRole('button', { name: 'Manage tags', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Manage tags', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Manage tags', exact: true })).toBeFocused();
    await activateOutside(page.getByRole('button', { name: 'Settings', exact: true }));
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(card).toHaveCount(1);

    await trigger.click();
    await activateOutside(page.getByRole('searchbox', { name: 'Search characters', exact: true }));
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('searchbox', { name: 'Search characters', exact: true })).not.toBeFocused();
    await trigger.click();
    await activateOutside(trigger);
    await expect(panel).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}
