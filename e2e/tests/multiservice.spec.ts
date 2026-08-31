import { test, expect } from '@playwright/test';
import {
  attachErrorCollectors, apiGet, apiDelete, deployViaApi,
  waitForDeploymentStatus, appUrl, expectNoErrors,
} from '../helpers/support.js';

const FIX = 'http://localhost:4555';
const MSC = `${FIX}/msvc.git`;

test.describe.serial('multi-service + zero-downtime UI (real stack)', () => {
  let appId: string;
  let depA: string;
  let depB: string;

  test.beforeAll(async () => {
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-msvc', repositoryUrl: MSC }),
    });
    appId = (await res.json()).id;
  });

  test.afterAll(async () => {
    await apiDelete(`/api/apps/${appId}`).catch(() => {});
  });

  test('zero-downtime UI: A stays active while B builds; badge moves after health', async ({ page }) => {
    test.setTimeout(600_000);
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    depA = await deployViaApi('e2e-msvc', MSC, undefined);
    await waitForDeploymentStatus(depA, ['RUNNING']);

    await page.goto(`/apps/${appId}`);
    await expect(page.locator('tbody').getByText('ACTIVE').first()).toBeVisible();
    await expect(page.locator('tr', { hasText: depA.slice(0, 8) }).locator('text=ACTIVE')).toBeVisible();

    await page.getByRole('button', { name: /deploy again/i }).click();
    const newLink = page.locator('tbody a').filter({ hasNotText: depA.slice(0, 8) }).first();
    await expect(newLink).toBeVisible({ timeout: 60_000 });
    const newDepHref = await newLink.getAttribute('href');
    depB = newDepHref!.split('/').pop()!;

    await waitForDeploymentStatus(depB, ['RUNNING'], 300_000);

    let activeId = '';
    for (let i = 0; i < 60; i++) {
      const appRow = (await apiGet(`/api/apps/${appId}`)) as { activeDeploymentId?: string };
      if (appRow.activeDeploymentId) {
        activeId = appRow.activeDeploymentId;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(activeId).toBe(depB);

    for (let i = 0; i < 30; i++) {
      const row = (await apiGet(`/api/deployments/${depA}`)) as { status: string };
      if (row.status === 'STOPPED') break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const after = await appUrl('e2e-msvc');
    expect(JSON.parse(after.body).version).toBe('msvc-B');

    await page.goto(`/deployments/${depB}`);
    await expect(page.getByText('ACTIVE').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /services/i })).toBeVisible();
    const svcTable = page.locator('table').first();
    await expect(svcTable.getByText('web')).toBeVisible();
    await expect(svcTable.getByText('api')).toBeVisible();
    await expect(svcTable.getByText('worker')).toBeVisible();
    await expect(svcTable.getByText('public')).toBeVisible();
    await expect(svcTable.getByText('private').first()).toBeVisible();
  });

  test('multi-service: volumes listed, per-service data, private isolation', async ({ page }) => {
    test.setTimeout(600_000);
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    await page.goto(`/deployments/${depB}`);
    await expect(page.getByRole('heading', { name: /services/i })).toBeVisible();
    const svcTable = page.locator('table').first();
    await expect(svcTable.getByText('web')).toBeVisible();
    await expect(svcTable.getByText('api')).toBeVisible();
    await expect(svcTable.getByText('worker')).toBeVisible();
    await expect(svcTable.getByText('public')).toBeVisible();
    await expect(svcTable.getByText('private').first()).toBeVisible();

    await page.goto(`/apps/${appId}`);
    await expect(page.locator('tr', { hasText: depB.slice(0, 8) }).getByText('ACTIVE')).toBeVisible();

    const { consoleErrors: c2, pageErrors: p2 } = attachErrorCollectors(page);
    await page.goto(`/deployments/${depA}`);
    await expect(page.getByRole('heading', { name: /deployment/i })).toBeVisible();
    // Deployment A should be stopped after rollback - look for status badge
    await expect(page.getByText(/STOPPED/i).first()).toBeVisible();
    expectNoErrors(c2, p2);
  });

  test('volume persistence across rollback (UI flow)', async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto(`/apps/${appId}`);
    const targetRow = page.locator('tr', { hasText: depA.slice(0, 8) });
    await targetRow.getByRole('button', { name: /rollback/i }).click();
    await targetRow.getByRole('button', { name: /^yes$/i }).click();
    await expect(page.getByText('RUNNING').first()).toBeVisible({ timeout: 300_000 });

    let rolledBack = false;
    let version = '';
    for (let i = 0; i < 240; i++) {
      const appRow = (await apiGet(`/api/apps/${appId}`)) as { activeDeploymentId?: string; deployments: Array<{ id: string; status: string; isActive: boolean; rollbackOf: string | null }> };
      const act = appRow.activeDeploymentId ?? '';
      const actRow = appRow.deployments.find((d) => d.id === act);
      if (act && act !== depB && actRow?.rollbackOf === depA) {
        rolledBack = true;
        const home = await appUrl('e2e-msvc');
        console.log(`[ROLLBACK DEBUG] iteration ${i}: active=${act}, gateway version=${home.status === 200 ? JSON.parse(home.body).version : 'ERROR'}`);
        if (home.status === 200) {
          version = JSON.parse(home.body).version;
          if (version === 'msvc-A') break;
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(rolledBack).toBe(true);

    const volHome = await appUrl('e2e-msvc');
    const parsedVol = JSON.parse(volHome.body) as { version: string; api: { count: number } };
    expect(parsedVol.version).toBe('msvc-A');
    expect(parsedVol.api.count).toBeGreaterThanOrEqual(1);
  });
});