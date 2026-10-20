import { expect, test } from '@playwright/test';
import packageInfo from '../../package.json' with { type: 'json' };

for (const width of [1440, 820, 390, 320]) {
  test(`application settings shares the workspace and scrolls categories at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 700 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    await page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true }).click();
    const navigation = page.getByRole('navigation', { name: 'Workspace' });
    await navigation.getByRole('button', { name: 'Libraries', exact: true }).click();
    const librarySidebar = await page.locator('.library-sidebar').boundingBox();
    const libraryContent = await page.locator('.library-panel').boundingBox();
    await navigation.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(navigation.getByRole('button', { name: 'Settings', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Data backup', exact: true })).toBeVisible();
    const categories = page.getByRole('navigation', { name: 'Settings categories' });
    const content = page.locator('.settings-panel');
    const sidebarBox = await page.locator('.library-sidebar').boundingBox();
    const contentBox = await content.boundingBox();
    if (!librarySidebar || !libraryContent || !sidebarBox || !contentBox) throw new Error('Missing workspace columns');
    expect(sidebarBox.x).toBe(librarySidebar.x);
    expect(sidebarBox.width).toBe(librarySidebar.width);
    expect(contentBox.x).toBe(libraryContent.x);
    expect(contentBox.width).toBe(libraryContent.width);
    if (width > 800) expect(contentBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width);
    else expect(contentBox.y).toBeGreaterThanOrEqual(sidebarBox.y + sidebarBox.height);

    const save = await page.getByRole('button', { name: 'Save backup', exact: true }).boundingBox();
    const importHeading = await page.getByRole('heading', { name: 'Import backup', exact: true }).boundingBox();
    if (!save || !importHeading) throw new Error('Missing backup controls');
    expect(save.width).toBeLessThan(200);
    expect(save.height).toBeLessThan(60);
    expect(importHeading.y).toBeGreaterThan(save.y + save.height);
    await expect(page.getByLabel('Inspect & import backup', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`settings-${width}.png`) });

    const pageNode = await content.elementHandle();
    await categories.getByRole('button', { name: 'Wipe application data', exact: true }).click();
    const wipeHeading = page.getByRole('heading', { name: 'Wipe application data', exact: true });
    await expect(wipeHeading).toBeFocused();
    await expect(wipeHeading).toBeInViewport();
    await expect(page.getByRole('region', { name: 'Data backup', exact: true })).toHaveCount(1);
    expect(await pageNode?.evaluate(node => node.isConnected)).toBe(true);
    await expect(navigation).toBeInViewport();
    await categories.getByRole('button', { name: 'About ORE', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'About ORE', exact: true })).toBeFocused();
    await expect(page.getByText(`${packageInfo.version} · Development build`, { exact: true })).toBeVisible();
    await expect(page.getByText('Unrecorded development checkout', { exact: true })).toBeVisible();
    expect(await content.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`about-${width}.png`) });
    await categories.getByRole('button', { name: 'Data backup', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Data backup', exact: true })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Save backup', exact: true })).toBeInViewport();
  });
}
