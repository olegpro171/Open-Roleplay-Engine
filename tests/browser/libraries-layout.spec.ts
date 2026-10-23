import { expect, test, type Page } from '@playwright/test';
import { defaultPrompt, type LibraryKind, type LibrarySnapshot } from '../../src/shared/library';
import { defaultContextPreset } from '../../src/shared/context';
import { newLorebook, newLoreEntry } from '../../src/shared/lorebook';

async function login(page: Page) {
  const session = await page.request.get('/api/session').then(response => response.json());
  await page.goto('/');
  await page.getByLabel('Owner password').fill('browser-synthetic-password');
  await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
}

async function library(page: Page): Promise<LibrarySnapshot> {
  return page.request.get('/api/library').then(response => response.json());
}

async function addRecord(page: Page, kind: LibraryKind, data: object) {
  const response = await page.request.post('/api/library', {
    headers: { Origin: 'http://127.0.0.1:4173' },
    data: { kind, revision: (await library(page)).revision, data },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test.describe('phone editor scroll recovery', () => {
  test.use({ hasTouch: true, isMobile: true });
  for (const height of [500, 900]) test(`closing a moving phone editor restores a short library at ${height}px`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height });
    await login(page);
    const name = `Momentum character ${height} run ${test.info().repeatEachIndex}`;
    await addRecord(page, 'characters', { name, description: 'A long source field.\n'.repeat(150), personality: '', scenario: '', first_mes: '', mes_example: '' });
    await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByPlaceholder('Search characters').fill(name);
    const content = page.getByRole('region', { name: 'Characters', exact: true });
    await expect(content.getByRole('article')).toHaveCount(1);
    const scroller = page.locator('main.library-layout');
    for (const action of ['Cancel', 'Save']) {
      await content.getByRole('button', { name: /^Edit(?: |$)/ }).click();
      await scroller.evaluate(node => { node.scrollTop = 600; });
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
      const session = await page.context().newCDPSession(page);
      const x = 380, y = height - 100;
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 18 }] });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: action, exact: true }).click();
      await expect.poll(() => scroller.evaluate(node => node.scrollTop)).toBe(0);
      await expect(page.getByPlaceholder('Search characters')).toBeInViewport();
      await expect(page.getByRole('navigation', { name: 'Library categories' })).toBeInViewport();
      await expect(content.getByRole('article')).toHaveCount(1);
      await session.detach();
    }
  });
});

test('Libraries reopens the last category and new Connections reserve 8,196 output tokens', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('button', { name: 'Create chat', exact: true }).click();
  await page.getByRole('button', { name: 'Return without saving', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'New Connection', exact: true }).click();
  await expect(page.getByLabel('Reserved output tokens', { exact: true })).toHaveValue('8196');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Connections', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: 'Connections', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

for (const width of [1280, 820, 800, 390, 320]) {
  test(`keeps Save and Cancel available while scrolling every library editor at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 820 ? 500 : 900 });
    await login(page);
    const { endpoint } = await page.request.get('/__test/endpoint').then(response => response.json());
    const fixtures: { kind: LibraryKind; category: string; data: object }[] = [
      { kind: 'personas', category: 'Personas', data: { description: 'A patient keeper.' } },
      { kind: 'characters', category: 'Characters', data: { description: 'The keeper waits.', personality: '', scenario: '', first_mes: '', mes_example: '' } },
      { kind: 'lorebooks', category: 'Lorebooks', data: newLorebook() },
      { kind: 'prompts', category: 'Prompts', data: defaultPrompt },
      { kind: 'connections', category: 'Connections', data: { endpoint, model: 'mock', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} } },
      { kind: 'contexts', category: 'Context presets', data: defaultContextPreset },
    ];
    for (const fixture of fixtures) {
      const name = `Sidebar editor ${fixture.kind} ${width}`;
      await addRecord(page, fixture.kind, { ...fixture.data, name });
      await page.getByRole('navigation', { name: 'Library categories' }).getByRole('button', { name: fixture.category, exact: true }).click();
      const content = page.getByRole('region', { name: fixture.category, exact: true });
      const article = () => content.getByRole('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
      const sidebarHeight = await page.locator('.library-sidebar').evaluate(element => element.getBoundingClientRect().height);
      await article().getByRole('button', { name: /^Edit(?: |$)/ }).click();
      if (width <= 800) {
        expect(await page.locator('.library-sidebar').evaluate(element => element.getBoundingClientRect().height)).toBe(sidebarHeight);
      }
      const actions = page.getByRole('group', { name: 'Editor actions', exact: true });
      const save = actions.getByRole('button', { name: 'Save', exact: true });
      const close = actions.getByRole('button', { name: 'Cancel', exact: true });
      await expect(save).toBeInViewport();
      await expect(close).toBeInViewport();
      const saveBounds = await save.boundingBox(), closeBounds = await close.boundingBox();
      if (!saveBounds || !closeBounds) throw new Error('Missing editor actions');
      if (width > 800) {
        const sidebar = await page.locator('.library-sidebar').boundingBox();
        if (!sidebar) throw new Error('Missing library sidebar');
        expect(saveBounds.x).toBeGreaterThanOrEqual(sidebar.x);
        expect(saveBounds.x + saveBounds.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
        expect(closeBounds.x).toBe(saveBounds.x);
        expect(closeBounds.y).toBeGreaterThanOrEqual(saveBounds.y + saveBounds.height);
        await expect(save).toHaveText('Save');
      } else {
        expect(closeBounds.x).toBeGreaterThanOrEqual(saveBounds.x + saveBounds.width);
        expect(closeBounds.y).toBe(saveBounds.y);
        expect(closeBounds.x + closeBounds.width).toBeGreaterThan(width - 40);
        expect(saveBounds.width).toBe(44);
        expect(saveBounds.height).toBe(44);
        await expect(save.locator('svg')).toBeVisible();
        await expect(close.locator('svg')).toBeVisible();
        await expect(save.locator('span')).toBeHidden();
        await expect(close.locator('span')).toBeHidden();
      }
      // Neither action moves with the form, including a short desktop viewport.
      const scroller = width > 800 ? content : page.locator('main.library-layout');
      await scroller.evaluate(element => element.scrollTo(0, element.scrollHeight));
      if (fixture.kind === 'characters') expect(await scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await expect(save).toBeInViewport();
      await expect(close).toBeInViewport();
      expect(await save.boundingBox()).toEqual(saveBounds);
      await page.screenshot({ path: testInfo.outputPath(`scrolled-${fixture.kind}.png`), animations: 'disabled' });
      await save.focus();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      const nameInput = content.getByLabel(fixture.kind === 'lorebooks' ? 'Book name' : 'Name', { exact: true });
      // Save retains native required-field validation.
      await nameInput.fill('');
      const before = await library(page);
      await save.click();
      expect((await library(page)).revision).toBe(before.revision);
      expect(await nameInput.evaluate(element => element instanceof HTMLInputElement && element.validity.valueMissing)).toBe(true);
      await nameInput.fill(`${name} saved`);
      await save.click();
      await expect(content.getByRole('heading', { name: `${name} saved`, exact: true })).toBeVisible();
      expect((await library(page))[fixture.kind].some(record => record.name === `${name} saved`)).toBe(true);
      await content.getByRole('article').filter({ has: page.getByRole('heading', { name: `${name} saved`, exact: true }) }).getByRole('button', { name: /^Edit(?: |$)/ }).click();
      await nameInput.fill('Discard this sidebar draft');
      await actions.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`sidebar-${fixture.kind}.png`), animations: 'disabled' });
      await close.click();
      await expect(actions).toHaveCount(0);
      expect((await library(page))[fixture.kind].some(record => record.name === 'Discard this sidebar draft')).toBe(false);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  });
}

test('preserves an editor draft across layout changes and submits from the keyboard', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Personas', exact: true }).click();
  await page.getByRole('button', { name: 'New persona', exact: true }).click();
  const name = 'Responsive keyboard persona';
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Persona description').fill('This draft survives changing the layout.');
  for (const width of [1280, 390, 820]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('Persona description')).toHaveValue('This draft survives changing the layout.');
    await expect(page.getByRole('group', { name: 'Editor actions', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
  }
  await page.getByLabel('Name', { exact: true }).press('Enter');
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  expect((await library(page)).personas.find(record => record.name === name)?.description).toBe('This draft survives changing the layout.');
});

test('fits loaded multiline text, preserves manual sizing while typing and remeasures newly opened fields', async ({ page }, testInfo) => {
  await login(page);
  const longText = 'An observatory keeper remembers the stars.\n'.repeat(100);
  const mediumText = Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`).join('\n');
  const character = { name: 'Sized character editor', titleComment: 'Night watch', description: longText, personality: '', scenario: 'A quiet night.', first_mes: '', mes_example: '', alternate_greetings: [longText] };
  await addRecord(page, 'characters', character);
  await addRecord(page, 'personas', { name: 'Sized persona editor', description: mediumText });
  await addRecord(page, 'lorebooks', { ...newLorebook(), name: 'Sized lorebook editor', entries: [{ ...newLoreEntry('sized-long-entry'), name: 'Long entry', content: longText }, { ...newLoreEntry('sized-short-entry'), name: 'Short entry', content: 'A small memory.' }] });
  await addRecord(page, 'prompts', { ...defaultPrompt, name: 'Sized prompt editor', blocks: [{ id: 'sized-text', name: 'Long prose', enabled: true, kind: 'text', role: 'system', text: longText }] });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Sized character editor · Night watch', exact: true }).click();
    const description = page.getByLabel('Character description', { exact: true });
    const measure = () => description.evaluate(element => ({ height: element.getBoundingClientRect().height, base: parseFloat(getComputedStyle(element).minHeight) }));
    const loaded = await measure();
    expect(loaded.height).toBe(loaded.base * 4);
    for (const label of ['Personality', 'Scenario']) {
      const field = page.getByLabel(label, { exact: true });
      expect(await field.evaluate(element => element.getBoundingClientRect().height)).toBe(loaded.base);
    }
    const name = await page.getByLabel('Name', { exact: true }).boundingBox(), title = await page.getByLabel('Title / comment', { exact: true }).boundingBox();
    if (!name || !title) throw new Error('Missing character identity fields');
    if (width > 800) expect(title.y).toBe(name.y);
    const pictureEditor = page.getByRole('region', { name: 'Character picture', exact: true });
    const picture = await pictureEditor.locator('.picture-editor-square').boundingBox();
    const choosePicture = await pictureEditor.locator('.file-button').boundingBox();
    if (!picture || !choosePicture) throw new Error('Missing picture controls');
    expect(choosePicture.x).toBeGreaterThan(picture.x + picture.width);
    expect(Math.abs(choosePicture.y - picture.y)).toBeLessThanOrEqual(1);
    const greetingGroup = page.getByRole('group', { name: 'Alternate greetings', exact: true });
    const groupBounds = await greetingGroup.boundingBox();
    const addBounds = await greetingGroup.getByRole('button', { name: 'Add alternate greeting', exact: true }).boundingBox();
    if (!groupBounds || !addBounds) throw new Error('Missing greeting controls');
    expect(Math.abs(groupBounds.x + groupBounds.width / 2 - addBounds.x - addBounds.width / 2)).toBeLessThanOrEqual(1);
    const greeting = page.getByLabel('Alternate greeting 1', { exact: true });
    const remove = page.getByRole('button', { name: 'Remove alternate greeting 1', exact: true });
    const greetingBounds = await greeting.boundingBox(), removeBounds = await remove.boundingBox();
    if (!greetingBounds || !removeBounds) throw new Error('Missing alternate greeting controls');
    expect(Math.abs(greetingBounds.x + greetingBounds.width - removeBounds.x - removeBounds.width)).toBeLessThanOrEqual(1);
    // A user's resize and subsequent typing must not snap back to the initial cap.
    await description.evaluate(element => { element.style.height = '510px'; });
    await description.fill(longText + 'A new line.');
    expect((await measure()).height).toBe(510);
    await page.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`character-editor-${width}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Sized character editor · Night watch', exact: true }).click();
    expect((await measure()).height).toBe(loaded.base * 4);
    await expect(description).toHaveValue(longText);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Personas', exact: true }).click();
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Sized persona editor', exact: true }) }).getByRole('button', { name: 'Edit', exact: true }).click();
    const medium = await page.getByLabel('Persona description').evaluate(element => ({ height: element.getBoundingClientRect().height, base: parseFloat(getComputedStyle(element).minHeight), fits: element.scrollHeight <= element.clientHeight }));
    expect(medium.height).toBeGreaterThan(medium.base);
    expect(medium.height).toBeLessThan(medium.base * 4);
    expect(medium.fits).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Lorebooks', exact: true }).click();
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Sized lorebook editor', exact: true }) }).getByRole('button', { name: 'Edit', exact: true }).click();
    const lore = page.getByLabel('Lore content', { exact: true });
    const longLore = await lore.evaluate(element => ({ height: element.getBoundingClientRect().height, base: parseFloat(getComputedStyle(element).minHeight) }));
    expect(longLore.height).toBe(longLore.base * 4);
    await page.getByRole('group', { name: 'Lorebook entries', exact: true }).getByRole('button', { name: /Short entry/ }).click();
    expect(await lore.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
    expect(await lore.evaluate(element => element.getBoundingClientRect().height)).toBe(longLore.base);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Prompts', exact: true }).click();
    await page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Sized prompt editor', exact: true }) }).getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('button', { name: 'Expand block 1', exact: true }).click();
    expect(await page.getByRole('textbox', { name: 'Block text', exact: true }).evaluate(element => element.getBoundingClientRect().height >= parseFloat(getComputedStyle(element).minHeight) * 4)).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test('keeps vertical library navigation beside a scrolling list and preserves failed editing drafts', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  const categories = page.getByRole('navigation', { name: 'Library categories' });
  const names = ['Chats', 'Personas', 'Characters', 'Lorebooks', 'Prompts', 'Connections', 'Context presets'];
  const actions = ['New chat', 'New persona', 'New character', 'New lorebook', 'New prompt', 'New Connection', 'New context preset'];
  const positions = await categories.getByRole('button').evaluateAll(buttons => buttons.map(button => {
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x, y, width, height };
  }));
  expect(positions).toHaveLength(names.length);
  for (let index = 1; index < positions.length; index++) {
    expect(positions[index].x).toBe(positions[0].x);
    expect(positions[index].y).toBeGreaterThanOrEqual(positions[index - 1].y + positions[index - 1].height);
  }
  for (const [index, name] of names.entries()) {
    const category = categories.getByRole('button', { name, exact: true });
    await category.focus();
    await category.press('Enter');
    await expect(category).toHaveAttribute('aria-pressed', 'true');
    const content = page.getByRole('region', { name, exact: true });
    await expect(content.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await expect(content.getByRole('button', { name: actions[index], exact: true })).toBeVisible();
    await expect(categories.locator('[aria-pressed=true]')).toHaveCount(1);
  }
  await categories.getByRole('button', { name: 'Personas', exact: true }).click();
  await page.getByRole('button', { name: 'New persona', exact: true }).click();
  const content = page.getByRole('region', { name: 'Personas', exact: true });
  await content.getByLabel('Name', { exact: true }).fill('Library layout persona');
  await content.getByLabel('Persona description').fill('A patient observatory keeper.');
  await page.route('**/api/library', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic library save conflict' }) })
    : route.continue());
  await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic library save conflict');
  await expect(content.getByLabel('Name', { exact: true })).toHaveValue('Library layout persona');
  await expect(content.getByLabel('Persona description')).toHaveValue('A patient observatory keeper.');
  expect((await library(page)).personas.some(persona => persona.name === 'Library layout persona')).toBe(false);
  await page.unroute('**/api/library');
  await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(content.getByRole('heading', { name: 'Library layout persona', exact: true })).toBeVisible();
  expect((await library(page)).personas.find(persona => persona.name === 'Library layout persona')?.description).toBe('A patient observatory keeper.');

  for (let index = 0; index < 12; index++) {
    for (const kind of ['personas', 'characters']) {
      const response = await page.request.post('/api/library', {
        headers: { Origin: 'http://127.0.0.1:4173' },
        data: {
          revision: (await library(page)).revision,
          kind,
          data: {
            name: `Scrolling layout ${kind} ${index}`,
            description: 'A synthetic library entry.',
            ...(kind === 'characters' ? { personality: '', scenario: '', first_mes: '', mes_example: '' } : {}),
          },
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
    }
  }
  await page.reload();
  await page.getByRole('button', { name: 'Libraries', exact: true }).click();
  await categories.getByRole('button', { name: 'Personas', exact: true }).click();
  const panel = await content.boundingBox(), navigation = await categories.boundingBox();
  if (!panel || !navigation) throw new Error('Missing library workspace');
  expect(panel.x).toBeGreaterThanOrEqual(navigation.x + navigation.width);
  expect(panel.width).toBeGreaterThan(navigation.width * 2);
  await page.screenshot({ path: testInfo.outputPath('libraries-desktop.png'), animations: 'disabled' });
  await content.getByRole('article').last().scrollIntoViewIfNeeded();
  await expect(categories.getByRole('button', { name: 'Chats', exact: true })).toBeInViewport();
  await expect(categories.getByRole('button', { name: 'Context presets', exact: true })).toBeInViewport();
  await categories.getByRole('button', { name: 'Characters', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Characters', exact: true }).getByRole('heading', { level: 1, name: 'Characters', exact: true })).toBeInViewport();
  await categories.getByRole('button', { name: 'Chats', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Chats', exact: true }).getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
});

test('keeps every category and the library editors usable on narrow screens', async ({ page }, testInfo) => {
  await login(page);
  const categories = page.getByRole('navigation', { name: 'Library categories' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['Chats', 'Personas', 'Characters', 'Lorebooks', 'Prompts', 'Connections', 'Context presets']) {
      await categories.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('region', { name, exact: true }).getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await categories.getByRole('button', { name: 'Personas', exact: true }).click();
    const content = page.getByRole('region', { name: 'Personas', exact: true });
    const panel = await content.boundingBox(), navigation = await categories.boundingBox();
    if (!panel || !navigation) throw new Error('Missing mobile library workspace');
    expect(panel.y).toBeGreaterThanOrEqual(navigation.y + navigation.height);
    await page.screenshot({ path: testInfo.outputPath(`libraries-phone-${width}.png`), animations: 'disabled' });
    await content.getByRole('button', { name: 'New persona', exact: true }).click();
    await content.getByLabel('Name', { exact: true }).fill('Unsaved phone persona');
    await content.getByLabel('Persona description').fill('A recoverable editing draft.');
    await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
    expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});

test('fits library editors within their forms at desktop and phone widths', async ({ page }, testInfo) => {
  await login(page);
  const categories = page.getByRole('navigation', { name: 'Library categories' });
  for (const width of [1024, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [name, action] of [['Prompts', 'New prompt'], ['Connections', 'New Connection'], ['Context presets', 'New context preset'], ['Characters', 'New character'], ['Lorebooks', 'New lorebook']]) {
      await categories.getByRole('button', { name, exact: true }).click();
      const content = page.getByRole('region', { name, exact: true });
      await content.getByRole('button', { name: action, exact: true }).click();
      await expect(content.getByLabel(name === 'Lorebooks' ? 'Book name' : 'Name', { exact: true })).toBeVisible();
      expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth), `${name} editor at ${width}px`).toBe(true);
      expect(await content.locator('form').evaluate(element => element.scrollWidth <= element.clientWidth), `${name} form at ${width}px`).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`libraries-${name}-${width}.png`), animations: 'disabled' });
      await page.getByRole('group', { name: 'Editor actions', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    }
  }
});

test('returns to the top of a scrollable prompt list after saving or closing a deep editor', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page);
  for (let index = 0; index < 8; index++) {
    await addRecord(page, 'prompts', { ...defaultPrompt, name: `Scroll position prompt ${index}` });
  }
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Prompts', exact: true });
  const edit = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Scroll position prompt 0', exact: true }) }).getByRole('button', { name: 'Edit', exact: true });
  await edit.click();
  for (let index = 1; index <= 6; index++) {
    await panel.getByRole('button', { name: `Expand block ${index}`, exact: true }).click();
  }
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await panel.getByRole('textbox', { name: 'Fallback text' }).last().fill('Edited while scrolled down.');
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'New prompt', exact: true })).toBeInViewport();
  expect(await panel.evaluate(element => element.scrollTop)).toBe(0);

  await edit.click();
  for (let index = 1; index <= 6; index++) {
    await panel.getByRole('button', { name: `Expand block ${index}`, exact: true }).click();
  }
  await panel.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'New prompt', exact: true })).toBeInViewport();
  expect(await panel.evaluate(element => element.scrollTop)).toBe(0);
});


test('aligns Restore and Delete across prompt cards at desktop and phone widths', async ({ page }, testInfo) => {
  await login(page);
  await addRecord(page, 'prompts', { ...defaultPrompt, name: 'Aligned prompt actions' });
  await page.getByRole('button', { name: 'Prompts', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Prompts', exact: true });
  const builtIn = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Default prompt', exact: true }) });
  const custom = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Aligned prompt actions', exact: true }) });
  for (const width of [1440, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const restore = builtIn.getByRole('button', { name: 'Restore', exact: true });
    const remove = custom.getByRole('button', { name: 'Delete', exact: true });
    const restoreSize = await restore.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    const deleteSize = await remove.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    expect(restoreSize).toEqual(deleteSize);
    const positions = await Promise.all([builtIn, custom].map(card => card.getByRole('button').evaluateAll(buttons => {
      const origin = buttons[0].closest('article')?.getBoundingClientRect();
      if (!origin) throw new Error('Missing prompt card');
      return buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return { x: rect.x - origin.x, y: rect.y - origin.y };
      });
    })));
    expect(positions[0]).toEqual(positions[1]);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await builtIn.screenshot({ path: testInfo.outputPath(`default-prompt-${width}.png`) });
    await custom.screenshot({ path: testInfo.outputPath(`prompt-actions-${width}.png`) });
  }
});


test('resets the built-in context and matches Delete width on desktop and phone', async ({ page }, testInfo) => {
  await login(page);
  await addRecord(page, 'contexts', { ...defaultContextPreset, name: 'Independent context actions' });
  const saved = (await library(page)).contexts.find(item => item.id === 'default-context');
  expect(saved).toBeDefined();
  const update = await page.request.put('/api/library/default-context', {
    headers: { Origin: 'http://127.0.0.1:4173' },
    data: { kind: 'contexts', revision: (await library(page)).revision, data: { ...defaultContextPreset, name: 'Customized context', minTail: 23 } },
  });
  expect(update.ok()).toBe(true);
  await page.getByRole('button', { name: 'Context presets', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Context presets', exact: true });
  const builtIn = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Customized context', exact: true }) });
  const custom = panel.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Independent context actions', exact: true }) });
  await expect(builtIn.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const size = (card: typeof builtIn, name: string) => card.getByRole('button', { name, exact: true }).evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    expect(await size(builtIn, 'Reset')).toEqual(await size(custom, 'Delete'));
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await builtIn.screenshot({ path: testInfo.outputPath(`context-reset-${width}.png`) });
  }
  await builtIn.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await library(page)).contexts.find(item => item.id === 'default-context')?.minTail).toBe(23);
  await builtIn.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Default context preset', exact: true })).toBeVisible();
  const reset = (await library(page)).contexts.find(item => item.id === 'default-context');
  expect(reset).toEqual({ ...defaultContextPreset, id: 'default-context', revision: reset?.revision });
  await expect(custom).toBeVisible();
});
