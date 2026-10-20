import { openChatTool } from './chat-tools';
import { test, expect } from '@playwright/test';
import type { ChatSnapshot } from '../../src/shared/contracts';
import type { ContextJobDetails } from '../../src/shared/context';
import { defaultContextPreset } from '../../src/shared/context';
import type { LibrarySnapshot } from '../../src/shared/library';

test('reviews a repair queue with matching panes, source diffs, regenerate, discard on Close and phone layout', async ({ page, request }) => {
  test.setTimeout(60_000);
  const securityErrors: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) securityErrors.push(message.text()); });
  const session = await request.get('/api/session').then(response => response.json());
  const { endpoint } = await request.get('/__test/endpoint').then(response => response.json());
  await request.post('/__test/mode', { data: { mode: 'normal' } });
  await page.goto('/'); await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Libraries', exact: true })).toBeVisible();
  const libraries = () => page.request.get('/api/library').then(response => response.json() as Promise<LibrarySnapshot>);
  const command = async (url: string, data: unknown, method = 'POST') => {
    const response = await page.request.fetch(url, { method, headers: { Origin: 'http://127.0.0.1:4173' }, data });
    expect(response.ok(), await response.text()).toBe(true); return response.json();
  };
  const connection = await command('/api/library', { revision: (await libraries()).revision, kind: 'connections', data: { name: 'Repair comparison model', model: 'synthetic-summary', endpoint, contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} } });
  const preset = await command('/api/library', { revision: (await libraries()).revision, kind: 'contexts', data: { ...defaultContextPreset, name: 'Repair comparison context', connectionId: connection.id, minTail: 2, batchSize: 2, promotionGroup: 2, retainedPerLevel: 1 } });
  const chat = await command('/api/chats', { title: 'Continuous repair proof', targetInputTokens: 500, connectionId: connection.id, promptId: 'default', characterId: null, personaId: null, contextPresetId: preset.id });
  const state = () => page.request.get(`/api/chats/${chat.id}`).then(response => response.json() as Promise<ChatSnapshot>);
  const requests = () => request.get('/__test/requests').then(response => response.json() as Promise<unknown[]>);
  await command(`/api/chats/${chat.id}/history`, { revision: (await state()).revision, turns: Array.from({ length: 18 }, (_, i) => ({ user: `Turn ${i + 1}. Mira gives Leon the brass key. ${'The quiet room. '.repeat(10)}`, assistant: 'Leon accepts the key. ' + 'He promises to return. '.repeat(10), complete: true })) }, 'PUT');
  await command(`/api/chats/${chat.id}/context/prepare`, { revision: (await state()).revision, requestId: crypto.randomUUID(), mode: 'prepare' });
  await expect.poll(async () => (await state()).context.jobs[0]?.status).not.toBe('running');
  expect((await state()).context.jobs[0], JSON.stringify((await state()).context.jobs[0])).toMatchObject({ status: 'succeeded' });
  const comparisonText = Array.from({ length: 24 }, (_, i) => `Scene ${i + 1}: Mira waits beside the cellar door. ${'She remembers the brass key and her promise to Leon. '.repeat(3)}`).join('\n\n');
  const firstSummary = (await state()).context.summaries.find(node => node.level === 1)!;
  await command(`/api/chats/${chat.id}/context/summaries/${firstSummary.id}`, { revision: (await state()).revision, summaryRevision: firstSummary.revision, text: comparisonText }, 'PATCH');
  await command(`/api/chats/${chat.id}/turns/${(await state()).turns[0].id}/user`, { revision: (await state()).revision, text: 'Mira kept the key. Leon never received it.' }, 'PATCH');
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Chats', exact: true }).click();
  await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Continuous repair proof', exact: true }) }).getByRole('button', { name: 'Open chat', exact: true }).click();
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await openChatTool(page, 'Inspect memory');
  await page.getByRole('button', { name: 'Repair summaries', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review the proposed replacement' });
  const proposal = () => dialog.getByLabel('Proposed summary', { exact: true });
  // Use the editor's paste handler. Browser execCommand replacement (Locator.fill)
  // copies highlight formatting into inline styles, bypassing that input path.
  const replaceProposal = async (text: string) => {
    await proposal().press('ControlOrMeta+a');
    await proposal().evaluate((element, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text);
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, text);
  };
  await expect(proposal()).toHaveAttribute('contenteditable', 'true');
  await expect(dialog.getByLabel('Previous summary', { exact: true })).toHaveAttribute('contenteditable', 'false');
  const previousBounds = await dialog.getByLabel('Previous summary', { exact: true }).boundingBox();
  const proposedBounds = await proposal().boundingBox();
  expect(proposedBounds!.x).toBeGreaterThan(previousBounds!.x + previousBounds!.width - 2);
  expect(await dialog.locator('.cm-mergeViewEditors').evaluate(element => getComputedStyle(element).display)).toBe('flex');
  expect(await dialog.locator('.cm-content').evaluateAll(elements => {
    const styles = elements.map(element => { const s = getComputedStyle(element); return [s.fontFamily, s.fontSize, s.lineHeight, s.padding].join('|'); });
    return styles[0] === styles[1];
  })).toBe(true);
  await replaceProposal(comparisonText.replace('Scene 12:', 'Scene twelve:'));
  await dialog.getByRole('checkbox', { name: 'Collapse unchanged', exact: true }).check();
  await expect(dialog.locator('.cm-collapsedLines').first()).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Collapse unchanged', exact: true }).uncheck();
  // CodeMirror renders a viewport of this long document. Reveal each scene
  // before asserting its DOM text; toggling collapse may retain the end caret.
  await proposal().press('ControlOrMeta+Home');
  await dialog.getByRole('button', { name: 'Next difference', exact: true }).first().click();
  await expect(proposal()).toContainText('Scene twelve:');
  await proposal().press('ControlOrMeta+End');
  await expect(proposal()).toContainText('Scene 24:');
  expect(await dialog.locator('.cm-mergeView').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await replaceProposal('Mira kept the key. This draft must be discarded.');
  await expect(dialog.locator('.cm-changedText').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Next difference', exact: true }).first().click();
  await expect(proposal()).toBeFocused();
  await dialog.getByText('Why this needs repair · compare sources', { exact: true }).click();
  await expect(dialog.getByLabel('Current sources', { exact: true })).toContainText('Mira kept the key');
  await expect(dialog.getByLabel('Previous sources', { exact: true })).toContainText('Mira gives Leon');
  await dialog.screenshot({ path: 'test-results/repair-desktop.png' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await state()).context.summaries.filter(node => !node.approved)).toEqual([]);
  const calls = (await requests()).length;
  await page.getByRole('button', { name: 'Repair summaries', exact: true }).click();
  await expect(proposal()).toHaveAttribute('contenteditable', 'true');
  await expect(proposal()).not.toContainText('This draft must be discarded');
  expect((await requests()).length).toBe(calls + 1);
  await replaceProposal('Reviewed continuity: Mira kept her key.');
  // Approval is durable even if generating the following candidate fails.
  await request.post('/__test/mode', { data: { mode: 'placeholder' } });
  await dialog.getByRole('button', { name: 'Approve & Next', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect((await state()).context.summaries.some(node => node.approved && node.text === 'Reviewed continuity: Mira kept her key.')).toBe(true);
  await request.post('/__test/mode', { data: { mode: 'normal' } });
  await dialog.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(proposal()).toHaveAttribute('contenteditable', 'true');
  await expect(dialog.getByRole('status').first()).toContainText('1 approved');
  // Resizing preserves the edited text while switching to a unified phone comparison.
  await replaceProposal('Phone correction: Mira kept her key.');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.locator('.repair-body > .comparison-unified')).toHaveCount(1);
  await expect(proposal()).toContainText('Phone correction');
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.screenshot({ path: 'test-results/repair-phone.png' });
  let approved = 0;
  while (await dialog.count() && approved++ < 50) {
    const button = dialog.getByRole('button', { name: /^Approve & (Next|Finish)$/ });
    await expect(button).toBeEnabled(); await button.click();
    await expect.poll(async () => (await state()).context.jobs[0].status).not.toBe('running');
    if ((await state()).context.jobs[0].status === 'succeeded') await expect(dialog).toHaveCount(0);
  }
  expect(approved).toBeGreaterThan(1); expect(approved).toBeLessThan(50);
  await expect(page.getByRole('button', { name: 'Repair summaries', exact: true })).toBeDisabled();
  expect((await state()).context.summaries.filter(node => !node.approved)).toEqual([]);
  // A fresh source edit can be closed while its provider request is still in progress.
  await command(`/api/chats/${chat.id}/turns/${(await state()).turns[0].id}/user`, { revision: (await state()).revision, text: 'Mira hid the brass key.' }, 'PATCH');
  await expect(page.getByRole('button', { name: 'Repair summaries', exact: true })).toBeEnabled();
  await request.post('/__test/mode', { data: { mode: 'hold' } });
  await page.getByRole('button', { name: 'Repair summaries', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await request.post('/__test/finish');
  await expect(dialog).toHaveCount(0);
  expect((await state()).context.jobs[0].status).toBe('cancelled');
  const details = await page.request.get(`/api/context/jobs/${(await state()).context.jobs[0].id}`).then(response => response.json() as Promise<ContextJobDetails>);
  expect(details.steps.some(step => step.status === 'candidate')).toBe(false);
  // Unchanged model results finish without review; history distinguishes local reuse.
  const beforeAutomatic = await state();
  await request.post('/__test/mode', { data: { mode: 'repair-unchanged' } });
  await page.getByRole('button', { name: 'Repair summaries', exact: true }).click();
  await expect(page.getByTestId('memory-repair-result')).toContainText('0 approved;');
  await expect(page.getByTestId('memory-repair-result')).toContainText('unchanged after model check');
  await expect(dialog).toHaveCount(0);
  const automatic = await state();
  expect(automatic.context.jobs[0].unchangedCount).toBeGreaterThan(0);
  const latestText = (snapshot: ChatSnapshot) => Object.fromEntries(snapshot.context.summaries.filter(node => node.approved).sort((a, b) => a.revision - b.revision).map(node => [node.id, node.text]));
  expect(latestText(automatic)).toEqual(latestText(beforeAutomatic));
  const autoDetails = await page.request.get(`/api/context/jobs/${automatic.context.jobs[0].id}`).then(response => response.json() as Promise<ContextJobDetails>);
  expect(autoDetails.steps.every(step => step.status === 'saved' && step.repairOutcome)).toBe(true);
  await page.getByRole('combobox', { name: 'Saved preparation', exact: true }).click();
  await page.getByRole('option', { name: /repair · succeeded/ }).first().click();
  await page.getByText('Summary requests and step outcomes', { exact: true }).click();
  await expect(page.getByText(/model checked · unchanged/).first()).toBeVisible();
  await request.post('/__test/mode', { data: { mode: 'normal' } });
  expect(securityErrors).toEqual([]);
});
