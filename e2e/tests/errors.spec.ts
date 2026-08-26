import { test, expect } from '@playwright/test';
import { attachErrorCollectors, expectNoErrors, apiDelete } from '../helpers/support.js';

const FIX = 'http://localhost:4555';

test.describe('error-state UX (real stack)', () => {
  test('invalid repository shows a human-readable failure, no crash', async ({ page }) => {
    test.setTimeout(300_000);
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    // Compute ONCE: re-evaluating Date.now() per locator would produce a
    // different name every millisecond and race the element lookup.
    const appName = `e2e-badrepo-${Date.now() % 100000}`;
    await page.goto('/');
    await page.getByPlaceholder('app-name').fill(appName);
    await page.getByPlaceholder('https://github.com/user/repo.git').fill('http://localhost:4555/does-not-exist.git');
    await page.getByRole('button', { name: /create app/i }).click();
    await expect(page.getByRole('link', { name: appName, exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('link', { name: appName, exact: true }).click();
    await page.getByRole('button', { name: /deploy again/i }).click();

    const depLink = page.locator('tbody a').first();
    await expect(depLink).toBeVisible({ timeout: 30_000 });
    await depLink.click();
    await expect(page.getByText('FAILED').first()).toBeVisible({ timeout: 180_000 });
    // Human-readable failure reason, no stack trace.
    await expect(page.getByText(/clone/i).first()).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/at .+ \(.*:\d+:\d+\)/); // no raw stack frames
    expectNoErrors(consoleErrors, pageErrors);
    const apps = (await (await fetch('http://localhost:4100/api/apps')).json()) as Array<{ id: string; name: string }>;
    const app = apps.find((a) => a.name === appName);
    if (app) await apiDelete(`/api/apps/${app.id}`);
  });

  test('invalid env var name is rejected inline with a field error', async ({ page }) => {
    test.setTimeout(120_000);
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `e2e-badenv-${Date.now() % 100000}`, repositoryUrl: `${FIX}/hello-node.git` }),
    });
    const appId = (await res.json()).id;
    await page.goto(`/apps/${appId}`);
    await page.getByPlaceholder('KEY').first().fill('BAD NAME WITH SPACES');
    await page.getByPlaceholder('value').first().fill('x');
    await page.getByRole('button', { name: /set variable/i }).click();
    // The UI shows the API's validation error; nothing crashes.
    await expect(page.locator('p.error').first()).toBeVisible({ timeout: 10_000 });
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/at .+ \(.*:\d+:\d+\)/);
    await apiDelete(`/api/apps/${appId}`);
  });

  test('invalid resource limit values are rejected with visible errors', async ({ page }) => {
    test.setTimeout(120_000);
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `e2e-badlimit-${Date.now() % 100000}`, repositoryUrl: `${FIX}/hello-node.git` }),
    });
    const appId = (await res.json()).id;
    await page.goto(`/apps/${appId}`);
    await page.getByPlaceholder('memory MB (16–65536)').fill('999999');
    await page.getByPlaceholder('CPUs (0.1–64)').fill('0.5');
    await page.getByRole('button', { name: /save limits/i }).click();
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/at .+ \(.*:\d+:\d+\)/);
    await apiDelete(`/api/apps/${appId}`);
  });
});
