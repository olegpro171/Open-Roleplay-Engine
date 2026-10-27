import { expect, mergeTests } from '@playwright/test';
import { test as appearanceTest } from './appearance-test';
import { test as isolatedTest } from './isolated-app';
import { appearanceStatusSchema, type Appearance } from '../../src/shared/appearance';

const test = mergeTests(isolatedTest, appearanceTest).extend<{ priorAppearance: Appearance }>({
  // The outer fixture checks saved state after setAppearance's cleanup, including
  // a save to an unrelated field made while the workflow owns the theme/colors.
  priorAppearance: [async ({ page, browserApp }, use) => {
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
    await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();
    const read = async () => appearanceStatusSchema.parse(await page.request.get('/api/application/appearance').then(response => response.json()));
    const current = await read();
    const settings: Appearance = {
      ...current.settings, theme: 'midnight-black', characterSpeechColor: '#abcdef',
      personaSpeechColor: '#fedcba', chatTextScale: 110, displayCharacterPicture: false,
    };
    const saved = await page.request.put('/api/application/appearance', {
      headers: { Origin: browserApp.url }, data: { revision: current.revision, settings },
    });
    expect(saved.ok()).toBe(true);
    await use(settings);
    expect((await read()).settings).toEqual({ ...settings, displayCharacterPicture: true });
  }, { auto: true }],
});

test('restores owned appearance fields while preserving unrelated saves', async ({ page, browserApp, setAppearance, priorAppearance }) => {
  const dark = await setAppearance({ theme: 'dark', characterSpeechColor: null, personaSpeechColor: null, chatTextScale: 100 });
  expect(dark.settings).toEqual({ ...priorAppearance, theme: 'dark', characterSpeechColor: null, personaSpeechColor: null, chatTextScale: 100 });
  // A second setup must retain the original values for cleanup.
  const light = await setAppearance({ theme: 'light' });
  const unrelated = await page.request.put('/api/application/appearance', {
    headers: { Origin: browserApp.url }, data: { revision: light.revision, settings: { ...light.settings, displayCharacterPicture: true } },
  });
  expect(unrelated.ok()).toBe(true);
});
