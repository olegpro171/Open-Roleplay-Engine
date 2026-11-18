import { expect, type Locator } from '@playwright/test';
import { test } from './isolated-app';
import type { LibrarySnapshot } from '../../src/shared/library';

test.use({ starterChat: false, browserName: 'webkit' });

test('keeps the New chat scroll position when participant cards replace their placeholders', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: 'Create owner account', exact: true }).click();
  const home = page.getByRole('main', { name: 'New chat' });
  await expect(home).toBeVisible();

  const { endpoint } = await (await page.request.get('/__test/endpoint')).json();
  const fixtures = [
    { kind: 'connections', data: { name: 'Local model', endpoint, model: 'mock', contextWindow: 64_000, maxOutputTokens: 1000, customParameters: {} } },
    ...['First character', 'Second character'].map(name => ({ kind: 'characters', data: {
      name, description: 'A guide who knows the paths by heart.', first_mes: '', personality: '', scenario: '', mes_example: '',
    } })),
    { kind: 'personas', data: { name: 'Traveller', description: 'Just passing through.' } },
  ];
  for (const fixture of fixtures) {
    const { revision }: LibrarySnapshot = await (await page.request.get('/api/library')).json();
    const response = await page.request.post('/api/library', {
      headers: { Origin: browserApp.url }, data: { ...fixture, revision },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  const character = home.getByRole('region', { name: 'Character', exact: true });
  const persona = home.getByRole('region', { name: 'Persona', exact: true });
  await expect(persona.getByRole('combobox')).toBeVisible();
  const position = () => home.evaluate(element =>
    new Promise<number>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.scrollTop)))));
  await home.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const bottom = await position();
  expect(bottom).toBeGreaterThan(0);
  const clickInPlace = async (control: Locator) => {
    await expect(control).toBeInViewport({ ratio: 1 });
    const bounds = await control.boundingBox();
    if (!bounds) throw new Error('Missing visible selection control');
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  };
  for (const [panel, name] of [[character, 'Second character'], [persona, 'Traveller']] as const) {
    for (const optionName of [name, 'None selected']) {
      await clickInPlace(panel.getByRole('combobox'));
      expect(await position(), 'opening the participant list').toBe(bottom);
      await clickInPlace(page.getByRole('option', { name: optionName, exact: true }));
      await expect(panel.getByRole('article')).toHaveCount(optionName === 'None selected' ? 0 : 1);
      expect(await position(), `choosing ${optionName}`).toBe(bottom);
    }
  }
});
