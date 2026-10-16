import { test, expect, devices } from '@playwright/test';

test('desktop and phone share streaming, recovery, edits, and inspectable requests', async ({ page, browser, request }) => {
  const password = 'browser-synthetic-password';
  const { endpoint } = await request.get('/__test/endpoint').then((response) => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill(password);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: 'Make room for a story.' })).toBeVisible();
  await page.getByRole('button', { name: 'Setup', exact: true }).click();
  await page.getByLabel('Model identifier').fill('synthetic-roleplay');
  await page.getByLabel('API base URL').fill(endpoint);
  await page.getByLabel('API key', { exact: true }).fill('browser-api-secret');
  await page.getByLabel('Chat title').fill('The Lantern Tower');
  await page.getByLabel('Character text').fill('You play the keeper of the tower.');
  await page.getByLabel('Persona text').fill('The user is a traveller.');
  await page.getByRole('button', { name: 'Save setup' }).click();
  await expect(page.getByRole('heading', { name: 'The Lantern Tower' })).toBeVisible();

  const phoneContext = await browser.newContext({ ...devices['iPhone 13'] });
  const phone = await phoneContext.newPage();
  await phone.goto('http://127.0.0.1:4173/');
  await phone.getByLabel('Owner password').fill(password);
  await phone.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(phone.getByLabel('Your next turn')).toBeVisible();

  await request.post('/__test/mode', { data: { mode: 'hold' } });
  await page.getByLabel('Your next turn').fill('I enter the tower.');
  await page.getByRole('button', { name: 'Request inspector' }).click();
  await page.getByRole('button', { name: 'Preview next request' }).click();
  const preview = JSON.parse((await page.getByTestId('request-body').textContent())!);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await page.getByRole('button', { name: 'Send turn' }).click();
  await expect(page.getByLabel('Conversation')).toContainText('The lantern');
  await expect(phone.getByLabel('Conversation')).toContainText('I enter the tower.');
  await expect(phone.getByLabel('Your next turn')).toBeDisabled();
  await phone.goto('about:blank');
  await request.post('/__test/finish', { data: {} });
  await expect(page.getByLabel('Conversation')).toContainText('The lantern flickers.');
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await phone.goto('http://127.0.0.1:4173/');
  await expect(phone.getByLabel('Conversation')).toContainText('The lantern flickers.');
  await expect(phone.getByLabel('Your next turn')).toBeEnabled();

  await phone.getByRole('button', { name: 'Request inspector' }).click();
  await expect(phone.getByTestId('request-body')).toContainText('I enter the tower.');
  const saved = JSON.parse((await phone.getByTestId('request-body').textContent())!);
  const captured = await request.get('/__test/requests').then((response) => response.json());
  expect(saved).toEqual(preview);
  expect(saved).toEqual(captured[0].body);
  expect(await phone.locator('body').textContent()).not.toContain('browser-api-secret');
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await phone.screenshot({ path: 'test-results/phone-request.png', fullPage: true });

  for (const part of ['input', 'response']) {
    await page.getByRole('button', { name: `Edit ${part}`, exact: true }).click();
    await page.getByLabel(`Edit ${part === 'input' ? 'user' : 'assistant'} text`).fill('');
    await page.getByRole('button', { name: 'Save edit' }).click();
  }
  await expect(page.getByText('Intentionally blank')).toHaveCount(2);
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await phone.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(phone.getByText('Intentionally blank')).toHaveCount(2);

  await page.getByLabel('Your next turn').fill('I light the lantern.');
  await page.getByRole('button', { name: 'Send turn' }).click();
  await expect(page.getByRole('button', { name: 'Cancel response' })).toBeVisible();
  await phone.getByRole('button', { name: 'Cancel response' }).click();
  await expect(page.getByRole('button', { name: 'Retry response' })).toBeVisible();
  await expect(page.getByLabel('Your next turn')).toBeDisabled();
  await request.post('/__test/mode', { data: { mode: 'normal' } });
  await page.getByRole('button', { name: 'Retry response' }).click();
  await expect(page.getByLabel('Your next turn')).toBeEnabled();
  await expect(phone.getByLabel('Your next turn')).toBeEnabled();
  await expect(page.getByRole('article')).toHaveCount(2);
  await phone.screenshot({ path: 'test-results/phone-chat.png', fullPage: true });
  await page.screenshot({ path: 'test-results/desktop-chat.png', fullPage: true });

  await phone.getByRole('button', { name: 'Setup', exact: true }).click();
  await expect(phone.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(phone.getByLabel('API key', { exact: true })).toHaveAttribute('placeholder', 'Saved · leave blank to keep it');
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await phoneContext.close();
});
