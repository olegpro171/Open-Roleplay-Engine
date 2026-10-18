import { test, expect, type Page } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

for (const width of [1440, 390]) {
  test(`edits card alternatives and selects durable opening response versions at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    const name = `Greeting keeper ${width}`;
    const card = { spec: 'chara_card_v3', spec_version: '3.0', data: {
      name, description: 'Synthetic greeting keeper.', first_mes: 'Welcome, {{user}}.',
      alternate_greetings: ['First alternative from {{char}}.', 'Remove this greeting.'],
    } };
    await page.getByLabel('Import character', { exact: true }).setInputFiles({ name: 'greetings.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(card)) });
    await page.getByRole('button', { name: 'Import reviewed character', exact: true }).click();
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    await expect(page.getByLabel('Alternate greeting 1', { exact: true })).toHaveValue('First alternative from {{char}}.');
    await page.getByLabel('Alternate greeting 1', { exact: true }).fill('Edited greeting for {{user}} from {{char}}.');
    await page.getByRole('button', { name: 'Remove alternate greeting 2', exact: true }).click();
    await page.getByRole('button', { name: 'Add alternate greeting', exact: true }).click();
    await page.getByLabel('Alternate greeting 2', { exact: true }).fill('A third beginning.\n\nA second paragraph.');
    await page.getByRole('group', { name: 'Alternate greetings', exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('greetings-editor.png'), fullPage: true });
    const imported = (await library(page)).characters.find(character => character.name === name);
    if (!imported) throw new Error('Missing imported character');
    await page.route(`**/api/library/${imported.id}`, route => route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic greeting save failure.' }) }), { times: 1 });
    await page.getByRole('button', { name: 'Save character', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Synthetic greeting save failure.' }).first()).toBeVisible();
    await expect(page.getByLabel('Alternate greeting 1', { exact: true })).toHaveValue('Edited greeting for {{user}} from {{char}}.');
    await page.getByRole('button', { name: 'Save character', exact: true }).click();
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    await expect(page.getByLabel('Alternate greeting 2', { exact: true })).toHaveValue('A third beginning.\n\nA second paragraph.');
    await page.getByLabel('Alternate greeting 1', { exact: true }).fill('Discard this draft.');
    await page.getByRole('button', { name: 'Close editor', exact: true }).click();
    await page.getByRole('button', { name: `Edit ${name}`, exact: true }).click();
    await expect(page.getByLabel('Alternate greeting 1', { exact: true })).toHaveValue('Edited greeting for {{user}} from {{char}}.');
    await page.getByRole('button', { name: 'Close editor', exact: true }).click();

    await page.getByRole('button', { name: 'Chats', exact: true }).click();
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    await page.getByRole('combobox', { name: 'Character', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
    await page.getByRole('button', { name: 'Create chat', exact: true }).click();
    await expect(page.getByLabel('Chat title')).toHaveValue(`${name} - Roleplay`);
    const chat = (await library(page)).chats.find(chat => chat.title === `${name} - Roleplay`);
    if (!chat) throw new Error('Missing created chat');
    const state = (): Promise<ChatSnapshot> => page.request.get(`/api/chats/${chat.id}`).then(response => response.json());
    await page.getByRole('button', { name: 'Story', exact: true }).click();
    const conversation = page.getByLabel('Conversation', { exact: true });
    await expect(conversation).toContainText('Welcome, You.');
    await expect(page.getByLabel('Response version', { exact: true })).toHaveValue('1');
    await expect(page.getByLabel('3 response versions', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next response', exact: true }).click();
    await expect(conversation).toContainText(`Edited greeting for You from ${name}.`);
    await page.getByLabel('Response version', { exact: true }).fill('3');
    await page.getByLabel('Response version', { exact: true }).press('Enter');
    await expect(conversation).toContainText('A third beginning.');
    await page.reload();
    await expect(conversation).toContainText('A third beginning.');
    await expect(page.getByLabel('Response version', { exact: true })).toHaveValue('3');
    await page.getByRole('button', { name: 'Previous response', exact: true }).click();
    await expect(conversation).toContainText(`Edited greeting for You from ${name}.`);
    await page.screenshot({ path: testInfo.outputPath('greetings-story.png'), fullPage: true });
    const saved = await state();
    expect(saved.turns).toHaveLength(1);
    expect(saved.turns[0]?.variants?.map(variant => variant.text)).toEqual(['Welcome, You.', `Edited greeting for You from ${name}.`, 'A third beginning.\n\nA second paragraph.']);
    expect(saved.generations).toHaveLength(0);
    await expect(page.locator('.part.user')).toHaveCount(0);
  });
}
