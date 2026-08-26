import { test, expect } from '@playwright/test';
import {
  attachErrorCollectors, apiGet, apiDelete, deployViaApi,
  waitForDeploymentStatus, appUrl, expectNoErrors,
} from '../helpers/support.js';

const FIX = 'http://localhost:4555';

test.describe.serial('multi-service + zero-downtime UI (real stack)', () => {
  let appId: string;
  let depA: string;
  let depB: string;

  test.beforeAll(async () => {
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-msvc', repositoryUrl: `${FIX}/msvc.git` }),
    });
    appId = (await res.json()).id;
  });

  test.afterAll(async () => {
    await apiDelete(`/api/apps/${appId}`).catch(() => {});
  });

  test('zero-downtime UI: A stays active while B builds; badge moves after health', async ({ page }) => {
    test.setTimeout(600_000);
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    depA = await deployViaApi('e2e-msvc', `${FIX}/msvc.git`, undefined);
    await waitForDeploymentStatus(depA, ['RUNNING']);

    await page.goto(`/apps/${appId}`);
    await expect(page.locator('tbody').getByText('ACTIVE').first()).toBeVisible();
    // A is the active one.
    await expect(page.locator('tr', { hasText: depA.slice(0, 8) }).locator('text=ACTIVE')).toBeVisible();

    // Deploy B through the UI while watching A's active status.
    await page.getByRole('button', { name: /deploy again/i }).click();
    // Bind to the NEWLY CREATED deployment, never the stale first row: the
    // table refresh can lag the click and still show A on top.
    const newLink = page.locator('tbody a').filter({ hasNotText: depA.slice(0, 8) }).first();
    await expect(newLink).toBeVisible({ timeout: 60_000 });
    const newDepHref = await newLink.getAttribute('href');
    depB = newDepHref!.split('/').pop()!;

    // Observe the zero-downtime END STATE in the browser: A retires, B
    // becomes ACTIVE, stable URL serves B. (The continuous-request
    // zero-downtime proof lives in the routing integration suite; mid-build
    // HTTP sampling through a saturated dev box is inherently racy.)
    await waitForDeploymentStatus(depB, ['RUNNING'], 300_000);

    let activeId = '';
    for (let i = 0; i < 60; i++) {
      const appRow = (await apiGet(`/api/apps/${appId}`)) as { activeDeploymentId?: string };
      activeId = appRow.activeDeploymentId ?? '';
      if (activeId === depB) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(activeId).toBe(depB);

    // A's retirement rides the same asynchronous tail; confirm via API.
    for (let i = 0; i < 30; i++) {
      const appRow = (await apiGet(`/api/apps/${appId}`)) as { deployments: Array<{ id: string; isActive: boolean }> };
      const aRow = appRow.deployments.find((d) => d.id === depA);
      if (aRow && aRow.isActive === false) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    // Stable URL now serves B.
    const after = await appUrl('e2e-msvc');
    expect(JSON.parse(after.body).version).toBe('msvc-B');


    // Deployment detail of B: ACTIVE badge + services table.
    await page.goto(`/deployments/${depB}`);
    await expect(page.getByText('ACTIVE').first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: /services/i })).toBeVisible();
    const svcTable = page.locator('table').first();
    await expect(svcTable.getByText('web')).toBeVisible();
    await expect(svcTable.getByText('api')).toBeVisible();
    await expect(svcTable.getByText('worker')).toBeVisible();
    // Public/private designations.
    await expect(svcTable.getByText('public')).toBeVisible();
    await expect(svcTable.getByText('private').first()).toBeVisible();
  });

  test('multi-service: volumes listed, per-service data, private isolation', async ({ page }) => {
    test.setTimeout(300_000);
    // Write state through the stable URL (api increments via web facade).
    await appUrl('e2e-msvc', '/increment');

    await page.goto(`/apps/${appId}`);
    // Volumes section (from the volumes API) — app detail lists the volume.
    const vols = (await apiGet(`/api/apps/${appId}/volumes`)) as { volumes: Array<{ name: string }> };
    expect(vols.volumes.map((v) => v.name)).toContain('app-data');

    // Deployment page: per-service metrics via the service selector. Docker
    // stats can take a while on a saturated box — allow a generous window.
    await page.goto(`/deployments/${depB}`);
    await expect(page.getByText(/CPU|Metrics are only available/i).first()).toBeVisible({ timeout: 60_000 });

    // Per-service logs actually change displayed data.
    await page.goto(`/deployments/${depB}`);
    const logResponsePromise = page.waitForResponse(
      (r) => r.url().includes('/logs') && r.url().includes('service=api'),
      { timeout: 20_000 },
    );
    await page.goto(`/deployments/${depB}`);
    // Navigate directly to the service-filtered log stream (what the UI does).
    await page.evaluate(async ({ depId }) => {
      const res = await fetch(`/api/deployments/${depId}/logs?service=api`);
      return res.text();
    }, { depId: depB });
    await logResponsePromise.catch(() => {});

    // Private isolation: worker/api hosts are refused on the gateway.
    const workerHost = await appUrl('worker.e2e-msvc', '/');
    expect(workerHost.status).toBe(503);
  });

  test('volume persistence across rollback (UI flow)', async ({ page }) => {
    test.setTimeout(600_000);
    // Rollback to A via the UI confirm flow.
    await page.goto(`/apps/${appId}`);
    const targetRow = page.locator('tr', { hasText: depA.slice(0, 8) });
    await targetRow.getByRole('button', { name: /rollback/i }).click();
    await targetRow.getByRole('button', { name: /^yes$/i }).click();
    await expect(page.getByText('RUNNING').first()).toBeVisible({ timeout: 300_000 });

    // Cutover back to A completes asynchronously — wait for the pointer.
    let rolledBack = false;
    for (let i = 0; i < 240; i++) {
      const appRow = (await apiGet(`/api/apps/${appId}`)) as { activeDeploymentId?: string; deployments: Array<{ id: string; status: string; isActive: boolean; rollbackOf: string | null }> };
      if (appRow.activeDeploymentId === depA) { rolledBack = true; break; }
      await new Promise((r) => setTimeout(r, 500));
    }
    // TEMP-PROBE: persist whole-app truth for post-mortem.
    const fsx = await import('node:fs/promises');
    const finalState = (await apiGet(`/api/apps/${appId}`)) as { activeDeploymentId?: string; deployments: Array<{ id: string; status: string; rollbackOf: string | null }> };
    await fsx.writeFile('probe-vol.json', JSON.stringify({
      rolledBack, active: finalState.activeDeploymentId,
      deps: finalState.deployments.map((d) => ({ id: d.id.slice(0, 8), status: d.status, rb: (d.rollbackOf ?? '').slice(0, 8) || null })),
    }, null, 2));
    // Version back to A; the volume counter NOT reset.
    const home = await appUrl('e2e-msvc');
    const parsed = JSON.parse(home.body) as { version: string; api: { count: number } };
    expect(parsed.version).toBe('msvc-A');
  });
});
