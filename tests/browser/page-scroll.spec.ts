import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) {
  test(`short viewport keeps login and settings reachable without moving chrome at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 300 });
    const session = await page.request.get('/api/session').then(response => response.json());
    await page.goto('/');
    const login = page.locator('.login');
    await expect(page.getByRole('heading')).toBeInViewport();
    await page.getByLabel('Owner password').fill('browser-synthetic-password');
    const submit = page.getByRole('button', { name: session.setupRequired ? 'Create owner account' : 'Sign in', exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    expect(await login.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`short-login-${width}.png`) });
    await submit.click();
    await page.setViewportSize({ width, height: 650 });
    await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Settings', exact: true }).click();
    const scrollArea = page.locator('.settings-panel');
    const categories = page.getByRole('navigation', { name: 'Settings categories', exact: true });
    const header = page.getByRole('banner');
    await expect(categories).toBeInViewport();
    const initialCategories = await categories.boundingBox();
    const initialHeader = await header.boundingBox();
    await scrollArea.hover();
    await page.mouse.wheel(0, 500);
    await expect.poll(() => scrollArea.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    await header.hover();
    await page.mouse.wheel(0, -500);
    expect(await header.boundingBox()).toEqual(initialHeader);
    expect(await categories.boundingBox()).toEqual(initialCategories);
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual({ x: 0, y: 0 });
    await page.screenshot({ path: testInfo.outputPath(`fixed-shell-${width}.png`) });
  });
}
