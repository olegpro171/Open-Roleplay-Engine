import { expect, test, type Page } from '@playwright/test';
import type { ChatSnapshot, RequestPreview } from '../../src/shared/contracts';
import type { LibrarySnapshot } from '../../src/shared/library';
import { legacyRoleplayPrompt } from '../../src/persistence/legacy-prompt';
import { newLorebook, newLoreEntry } from '../../src/shared/lorebook';

async function choose(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}

test('edits card instructions, enables preset injection, explains unavailable sources and sends the inspected request', async ({ page }) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const library = () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const command = async (url: string, data: unknown, method = 'POST') => {
    const response = await page.request.fetch(url, { method, headers: { Origin: 'http://127.0.0.1:4173' }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await page.request.post('/__test/mode', { data: { mode: 'normal' } });
  const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
  const connection = await command('/api/library', { kind: 'connections', revision: (await library()).revision, data: { name: 'Card proof', endpoint, model: 'synthetic-roleplay', contextWindow: 100000, maxOutputTokens: 1000, customParameters: {} }, apiKey: 'SYNTHETIC-CARD-BROWSER-SECRET' });
  const fields = { name: 'Instruction Mira', description: 'Keeps the key.', personality: '', scenario: '', first_mes: '', mes_example: '' };
  const character = await command('/api/library', { kind: 'characters', revision: (await library()).revision, data: { ...fields, source: { spec: 'chara_card_v3', data: { ...fields, system_prompt: '{{original}} Narrate {{char}}.', post_history_instructions: 'End with dialogue.', extensions: { depth_prompt: { prompt: 'Keep secrets.', depth: 1, role: 'assistant' }, custom: 'Preserved' } } } } });
  const prompt = await command('/api/library', { kind: 'prompts', revision: (await library()).revision, data: { ...legacyRoleplayPrompt, name: 'Card permission proof' } });
  const lorebook = await command('/api/library', { kind: 'lorebooks', revision: (await library()).revision, data: { ...newLorebook(), name: 'Card warning proof', entries: [
    { ...newLoreEntry('missing'), name: 'Missing personality', content: 'Must stay absent.', constant: true, placement: 'personality' },
    { ...newLoreEntry('history'), name: 'History lore', content: 'Lore at depth one.', constant: true, placement: 'history', depth: 1 },
  ] } });
  const chat = await command('/api/chats', { title: 'Card instructions story', targetInputTokens: 5000, characterId: character.id, connectionId: connection.id, promptId: prompt.id, personaId: null, lorebookId: lorebook.id });
  const state = () => page.request.get(`/api/chats/${chat.id}`).then(response => response.json() as Promise<ChatSnapshot>);
  await command(`/api/chats/${chat.id}/history`, { revision: (await state()).revision, turns: [{ user: 'Old input', assistant: 'Old response', complete: true }] }, 'PUT');
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Card instructions story', exact: true }) }).getByRole('button', { name: 'Open chat', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Chat settings', exact: true })).toHaveText('Chat settings (4)');
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click();
  const warnings = page.getByRole('region', { name: 'Prompt configuration warnings', exact: true });
  await expect(warnings.getByRole('listitem')).toHaveCount(4);
  await expect(warnings).toContainText('Missing personality');
  // A selection change updates structural diagnostics without saving the chat.
  await choose(page, 'Character', 'None selected');
  await expect(warnings.getByRole('listitem')).toHaveCount(1);
  await choose(page, 'Character', 'Instruction Mira');
  await expect(warnings.getByRole('listitem')).toHaveCount(4);
  await page.screenshot({ path: 'test-results/card-warnings-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await warnings.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/card-warnings-phone.png', fullPage: true });
  await warnings.getByRole('button', { name: 'Edit prompt preset', exact: true }).first().click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Card permission proof');
  await page.getByRole('button', { name: 'Expand block 5', exact: true }).click();
  await expect(page.getByLabel('Allow character depth prompt injection')).not.toBeChecked();
  await page.getByLabel('Allow character depth prompt injection').check();
  await page.getByRole('button', { name: 'Add marker', exact: true }).click();
  await page.getByRole('button', { name: 'Expand block 6', exact: true }).click();
  await choose(page, 'Marker source for block 6', 'Card system prompt');
  await page.getByLabel('Fallback text').fill('Base {{char}}.');
  for (let index = 6; index > 1; index--) await page.getByRole('button', { name: `Move block ${index} up`, exact: true }).click();
  await page.getByRole('button', { name: 'Add marker', exact: true }).click();
  await page.getByRole('button', { name: 'Expand block 7', exact: true }).click();
  await choose(page, 'Marker source for block 7', 'Card post-history instructions');
  await page.getByRole('button', { name: 'Save prompt', exact: true }).click();
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Chat settings', exact: true })).toHaveText('Chat settings (1)');
  await page.getByRole('button', { name: 'Chat settings', exact: true }).click();
  await expect(warnings.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Instruction Mira', exact: true }) }).getByRole('button', { name: 'Edit Instruction Mira', exact: true }).click();
  await page.getByText('Card instructions', { exact: true }).click();
  await expect(page.getByLabel('Card system prompt', { exact: true })).toHaveValue('{{original}} Narrate {{char}}.');
  await expect(page.getByLabel('Character note depth', { exact: true })).toHaveValue('1');
  await choose(page, 'Character note role', 'assistant');
  await page.getByLabel('Character depth note', { exact: true }).fill('Keep the key secret, {{char}}.');
  await page.screenshot({ path: 'test-results/card-instructions-phone.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Character depth note', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/card-instructions-desktop.png', fullPage: true });
  await page.route(`**/api/library/${character.id}`, route => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic failed save.' }) }));
  await page.getByRole('button', { name: 'Save character', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry same save', exact: true })).toBeVisible();
  await expect(page.getByLabel('Character depth note', { exact: true })).toHaveValue('Keep the key secret, {{char}}.');
  await page.unroute(`**/api/library/${character.id}`);
  await page.getByRole('button', { name: 'Retry same save', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Instruction Mira', exact: true })).toBeVisible();
  const exported = await page.request.get(`/api/library/characters/${character.id}/export`).then(response => response.json());
  expect(exported.data.extensions).toMatchObject({ custom: 'Preserved', depth_prompt: { prompt: 'Keep the key secret, {{char}}.', depth: 1, role: 'assistant' } });
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await page.getByLabel('Your next turn').fill('Continue now.');
  await page.locator('.context-dropdown > summary').click();
  await page.getByRole('button', { name: 'Prompt peek', exact: true }).click();
  const peek = page.getByRole('dialog', { name: 'Prompt peek', exact: true });
  await expect(peek).toContainText('system_prompt · card');
  await expect(peek).toContainText('Character depth note · depth 1');
  await page.screenshot({ path: 'test-results/card-peek-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Close peek', exact: true }).click();
  const preview: RequestPreview = await command(`/api/chats/${chat.id}/preview`, { revision: (await state()).revision, text: 'Continue now.' });
  expect(preview.body.messages).toEqual([
    { role: 'system', content: 'Base Instruction Mira. Narrate Instruction Mira.' },
    { role: 'system', content: 'Write the next response in this roleplay. Stay consistent with the established story.' },
    { role: 'system', content: 'Instruction Mira' }, { role: 'system', content: 'Keeps the key.' },
    { role: 'user', content: 'Old input' }, { role: 'assistant', content: 'Old response' },
    { role: 'system', content: 'Lore at depth one.' }, { role: 'assistant', content: 'Keep the key secret, Instruction Mira.' },
    { role: 'user', content: 'Continue now.' }, { role: 'system', content: 'End with dialogue.' },
  ]);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await state()).generations[0]?.status).toBe('succeeded');
  const requests: { body: object }[] = await page.request.get('/__test/requests').then(response => response.json());
  expect(requests.at(-1)?.body).toEqual(preview.body);
  const savedRequest = (await state()).generations[0].request;
  // Submitting the draft changes only its inspection classification, not input.
  expect(savedRequest?.layout).toEqual(preview.layout?.map(part => part.kind === 'draft' ? { ...part, kind: 'history', label: 'Turn 2 · input' } : part));
});
