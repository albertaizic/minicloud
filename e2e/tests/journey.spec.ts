import { test, expect } from '@playwright/test';
import {
  appUrl, attachErrorCollectors, deployViaApi, expectNoErrors,
  waitForDeploymentStatus, apiGet, apiDelete,
} from '../helpers/support.js';

const REPO = 'http://localhost:4555/hello-node.git';

test.describe('clean-user journey (real stack)', () => {
  let appSlug: string;
  let appId: string;

  test('dashboard loads from a clean stack with no errors', async ({ page }) => {
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    const failedRequests: string[] = [];
    page.on('requestfailed', (req) => failedRequests.push(req.url()));
    page.on('response', (res) => {
      if (res.status() >= 500) failedRequests.push(`${res.status()} ${res.url()}`);
    });

    await page.goto('/');
    await expect(page).toHaveTitle(/MiniCloud/i);
    await expect(page.getByRole('heading', { name: /applications/i })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expectNoErrors(consoleErrors, pageErrors);
    // API health probes from the page must not have 5xx'd.
    expect(failedRequests.filter((u) => u.includes('/api/'))).toHaveLength(0);
  });

  test('create + deploy hello-node through the dashboard and reach RUNNING', async ({ page }) => {
    test.setTimeout(600_000);
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    appSlug = `e2e-hello-${Date.now() % 100000}`;
    await page.goto('/');
    await page.getByPlaceholder('app-name').fill(appSlug);
    await page.getByPlaceholder('https://github.com/user/repo.git').fill(REPO);
    await page.getByRole('button', { name: /create app/i }).click();
    await expect(page.getByRole('link', { name: appSlug }).first()).toBeVisible({ timeout: 15_000 });

    // Open the application page and deploy through the UI.
    await page.getByRole('link', { name: appSlug }).first().click();
    await expect(page.getByRole('heading', { name: appSlug })).toBeVisible();
    await page.getByText(new RegExp(`^${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)).or(
      page.getByText('hello-node.git'),
    ).first().click();

    await page.getByRole('button', { name: /deploy again/i }).click();

    // The deployments table must appear immediately with a queued/early state.
    const depLink = page.locator('tbody a').first();
    await expect(depLink).toBeVisible({ timeout: 20_000 });

    // Open the deployment page and watch it transition to RUNNING without reload.
    await depLink.click();
    await expect(page.getByText('RUNNING').first()).toBeVisible({ timeout: 480_000 });

    // Event timeline rendered with lifecycle events.
    await expect(page.getByRole('heading', { name: /events/i })).toBeVisible();
    await expect(page.locator('table').getByText('deployment.running').first()).toBeVisible({ timeout: 180_000 });

    // Metrics section renders for a RUNNING deployment.
    await expect(page.getByRole('heading', { name: /metrics/i })).toBeVisible();
    await expect(page.getByText(/CPU/i).first()).toBeVisible();

    // Logs viewer present.
    await expect(page.getByRole('heading', { name: /logs/i })).toBeVisible();

    expectNoErrors(consoleErrors, pageErrors);

    // Resolve ids for the stable-URL + API cross-checks.
    const apps = (await (await fetch('http://localhost:4100/api/apps')).json()) as Array<{
      id: string; name: string; url: string; activeDeploymentId: string;
    }>;
    const app = apps.find((a) => a.name === appSlug)!;
    appId = app.id;
    expect(app.url).toBe(`http://${appSlug}.localhost:8080`);
    expect(app.activeDeploymentId).toBeTruthy();
    const dep = (await apiGet(`/api/deployments/${app.activeDeploymentId}`)) as {
      isActive: boolean; commitSha: string | null;
    };
    expect(dep.isActive).toBe(true);
    expect(dep.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // The stable URL actually serves the application.
    const served = await appUrl(appSlug, '/health');
    expect(served.status).toBe(200);
    expect(JSON.parse(served.body).status).toBe('ok');

    // Back on the app page: stable URL + active deployment visible without reload.
    await page.goto(`/apps/${appId}`);
    await expect(page.getByText(`http://${appSlug}.localhost:8080`)).toBeVisible();
  });

  test('application page shows the full operational picture', async ({ page }) => {
    test.setTimeout(120_000);
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    await page.goto(`/apps/${appId}`);
    await expect(page.getByRole('heading', { name: 'e2e-hello' })).toBeVisible();
    await expect(page.getByText('hello-node.git').first()).toBeVisible();
    await expect(page.getByText(/stable url/i)).toBeVisible();
    await expect(page.getByText(/restart policy/i)).toBeVisible();
    await expect(page.getByText(/environment variables/i)).toBeVisible();
    await expect(page.getByText(/resource limits/i)).toBeVisible();
    // Deployment history row with status badge.
    await expect(page.locator('tbody').getByText('RUNNING').first()).toBeVisible();
    // Active marker present.
    await expect(page.locator('tbody').getByText('ACTIVE').first()).toBeVisible();
    expectNoErrors(consoleErrors, pageErrors);
  });

  test('cleanup', async () => {
    if (appId) {
      await waitForDeploymentStatus(
        (await apiGet(`/api/apps/${appId}`)).activeDeploymentId,
        ['RUNNING', 'FAILED', 'STOPPED'],
        60_000,
      );
      await apiDelete(`/api/deployments/${(await apiGet(`/api/apps/${appId}`)).activeDeploymentId}?force=true`);
      await apiDelete(`/api/apps/${appId}`);
    }
  });
});
