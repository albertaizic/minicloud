import { test, expect, type Page } from '@playwright/test';
import { attachErrorCollectors, expectNoErrors, apiGet, apiDelete, deployViaApi, waitForDeploymentStatus } from '../helpers/support.js';
import fs from 'node:fs';

const FIX = 'http://localhost:4555';
const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 720 },
  { name: 'mobile-390', width: 390, height: 844 },
];

const SHOT_DIR = '../e2e-artifacts/screenshots';

async function shoot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** Overflow check: no horizontal scrolling beyond the viewport. */
async function expectNoHorizontalOverflow(page: Page, context: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  // Allow tiny sub-pixel differences; a real overflow is >8px.
  expect(
    overflow.scroll - overflow.viewport,
    `${context}: horizontal overflow ${overflow.scroll}px vs viewport ${overflow.viewport}px`,
  ).toBeLessThanOrEqual(8);
}

let appId: string;
let activeDep: string;
let failedDep: string;

test.describe.serial('visual / UX audit', () => {
  test.beforeAll(async () => {
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-visual', repositoryUrl: `${FIX}/hello-node.git` }),
    });
    appId = (await res.json()).id;
    activeDep = await deployViaApi('e2e-visual', `${FIX}/hello-node.git`);
    await waitForDeploymentStatus(activeDep, ['RUNNING']);

    // A FAILED deployment for the error-state screenshots.
    failedDep = await deployViaApi('e2e-visual', `${FIX}/failing-app.git`);
    await waitForDeploymentStatus(failedDep, ['FAILED'], 300_000);
  });

  for (const vp of VIEWPORTS) {
    test(`visual audit @ ${vp.name}`, async ({ browser }) => {
      test.setTimeout(240_000);
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const { consoleErrors, pageErrors } = attachErrorCollectors(page);

      // Overview.
      await page.goto('/');
      await expect(page.getByRole('heading', { name: /applications/i })).toBeVisible();
      await expectNoHorizontalOverflow(page, `overview ${vp.name}`);
      await shoot(page, `01-overview-${vp.name}`);

      // Application detail (running app).
      await page.goto(`/apps/${appId}`);
      await expect(page.getByRole('heading', { name: 'e2e-visual' })).toBeVisible();
      await expectNoHorizontalOverflow(page, `app ${vp.name}`);
      await shoot(page, `02-app-detail-${vp.name}`);

      // Configuration section.
      await expect(page.getByText(/environment variables/i)).toBeVisible();
      await shoot(page, `03-config-${vp.name}`);

      // Deployment detail (RUNNING): metrics, events, logs.
      await page.goto(`/deployments/${activeDep}`);
      await expect(page.getByText('RUNNING').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: /events/i })).toBeVisible();
      await expectNoHorizontalOverflow(page, `deployment ${vp.name}`);
      await shoot(page, `04-deployment-${vp.name}`);

      // Event timeline / log viewer close-up.
      await page.locator('h2:has-text("Logs")').scrollIntoViewIfNeeded();
      await shoot(page, `05-logs-${vp.name}`);

      // FAILED deployment error state.
      await page.goto(`/deployments/${failedDep}`);
      await expect(page.getByText('FAILED').first()).toBeVisible({ timeout: 30_000 });
      await shoot(page, `06-failed-${vp.name}`);

      await ctx.close();
      expectNoErrors(consoleErrors, pageErrors);
    });
  }

  test('multi-service visual audit', async ({ browser }) => {
    test.setTimeout(600_000);
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-ms-visual', repositoryUrl: `${FIX}/msvc.git` }),
    });
    const msApp = (await res.json()).id;
    const dep = await deployViaApi('e2e-ms-visual', `${FIX}/msvc.git`);
    await waitForDeploymentStatus(dep, ['RUNNING']);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`/deployments/${dep}`);
    await expect(page.getByRole('heading', { name: /services/i })).toBeVisible();
    await expect(page.locator('table').getByText('worker')).toBeVisible();
    await shoot(page, `07-multiservice-1440`);
    await expectNoHorizontalOverflow(page, 'multiservice');
    await ctx.close();
    await apiDelete(`/api/apps/${msApp}`);
  });

  test.afterAll(async () => {
    await apiDelete(`/api/apps/${appId}`).catch(() => {});
  });
});
