import { confirmLeaveEditor, openLibraryActions } from './library-card-helpers';
import { test, expect } from '@playwright/test';
import type { LibrarySnapshot } from '../../src/shared/library';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`deletion confirmation preserves data on dismissal and stale writes at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    if (viewport.width === 1280) {
      await page.addInitScript(() => {
        // Safari 26.5 can restore focus even when close() runs after removal.
        // Reproduce that browser behavior while keeping the real modal lifecycle.
        const openers = new WeakMap<HTMLDialogElement, Element | null>();
        const { showModal, close } = HTMLDialogElement.prototype;
        HTMLDialogElement.prototype.showModal = function () {
          if (!this.open) openers.set(this, document.activeElement);
          showModal.call(this);
        };
        HTMLDialogElement.prototype.close = function (returnValue) {
          close.call(this, returnValue);
          const opener = openers.get(this);
          if (!this.isConnected && opener instanceof HTMLElement) opener.focus();
        };
      });
    }
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Libraries', exact: true }).click();
    await page.getByRole('button', { name: 'Personas', exact: true }).click();
    await page.getByRole('button', { name: 'New persona', exact: true }).click();
    const name = `Traveller ${viewport.width} <b>literal</b> ${'long name '.repeat(7)}`.trim();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
    const trigger = row.getByRole('button', { name: /^Actions for / });
    const dialog = page.getByRole('dialog', { name: 'Delete library item?' });
    const library = (): Promise<LibrarySnapshot> => page.request.get('/api/library').then(response => response.json());
    const before = await library();
    let deletes = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/deletion')) deletes++; });
    page.on('dialog', () => { throw new Error('Unexpected browser confirmation'); });
    const theme = await page.locator('html').getAttribute('data-theme');
    try {
      for (const preview of ['dark', 'light', 'midnight-black']) {
        await page.locator('html').evaluate((element, value) => element.setAttribute('data-theme', value), preview);
        await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(trigger).not.toBeFocused();
        await expect(row).toBeVisible();
        expect(deletes).toBe(0);
        await row.screenshot({ path: testInfo.outputPath(`dismissed-${preview}.png`) });
      }
    } finally {
      await page.locator('html').evaluate((element, value) => {
        if (value === null) element.removeAttribute('data-theme');
        else element.setAttribute('data-theme', value);
      }, theme);
    }

    await trigger.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger.locator(':scope:focus-visible')).toHaveCount(1);
    expect((await library()).revision).toBe(before.revision);

    await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).not.toBeFocused();

    await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await expect(dialog).toContainText(`Delete “${name}” from the library?`);
    await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeInViewport();
    expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('confirmation.png') });
    await page.mouse.click(2, 2);
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(row).toBeVisible();
    expect(deletes).toBe(0);
    await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('heading', { level: 2 })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(deletes).toBe(0);
    expect((await library()).revision).toBe(before.revision);

    // A changed target requires a fresh review and confirmation.
    await (await openLibraryActions(page, row)).getByRole('menuitem', { name: 'Delete', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
    const item = before.personas.find(item => item.name === name);
    if (!item) throw new Error('Missing saved persona');
    const update = await page.request.put(`/api/library/${item.id}`, {
      headers: { Origin: 'http://127.0.0.1:4173' },
      data: { kind: 'personas', revision: before.revision, data: { name, description: 'Edited on another device' } },
    });
    expect(update.ok()).toBe(true);
    await page.keyboard.press('Enter');
    await expect(dialog.getByRole('alert')).toHaveText('Linked items have changed. Review the updated list before deleting.');
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
    expect((await library()).personas.some(item => item.name === name)).toBe(true);
    await dialog.getByRole('heading', { level: 2 }).dispatchEvent('keydown', { key: 'Enter', repeat: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(deletes).toBe(2);
    await page.reload();
    expect((await library()).personas.some(item => item.name === name)).toBe(false);
  });
}

test('lore entry deletion stays in the book draft until saved', async ({ page }) => {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Lorebooks', exact: true }).click();
  await page.getByRole('button', { name: 'New lorebook', exact: true }).click();
  await page.getByLabel('Book name', { exact: true }).fill('Deletion draft atlas');
  await page.getByRole('button', { name: 'Add entry', exact: true }).click();
  await page.getByLabel('Entry name', { exact: true }).fill('Keep the gate');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const row = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Deletion draft atlas', exact: true }) });
  await row.getByRole('heading').getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: 'Delete lore entry?' });
  const entry = page.getByLabel('Entry name', { exact: true });
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(entry).toHaveValue('Keep the gate');
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await expect(dialog.getByRole('heading')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(entry).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await confirmLeaveEditor(page);
  await row.getByRole('heading').getByRole('button').click();
  await expect(entry).toHaveValue('Keep the gate');
  await page.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete entry', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('0 entries');
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('button', { name: 'Lorebooks', exact: true }).click();
  await row.getByRole('heading').getByRole('button').click();
  await expect(entry).toHaveCount(0);
});
