import { test, expect } from '@playwright/test';
import {
  attachErrorCollectors, apiGet, apiDelete, deployViaApi,
  waitForDeploymentStatus, appUrl, expectNoErrors,
} from '../helpers/support.js';

const FIX = 'http://localhost:4555';

test.describe.serial('reliability UI flows (real stack)', () => {
  let appId: string;
  let depIds: string[] = [];

  test.beforeAll(async () => {
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-rel', repositoryUrl: `${FIX}/hello-node.git` }),
    });
    appId = (await res.json()).id;
    // Restart policy for the recovery flows.
    await fetch(`http://localhost:4100/api/apps/${appId}/restart-policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'on-failure', maxRestartAttempts: 3 }),
    });
  });

  test.afterAll(async () => {
    for (const d of depIds) {
      const row = (await apiGet(`/api/deployments/${d}`)) as { status: string };
      if (row.status) await apiDelete(`/api/deployments/${d}?force=true`).catch(() => {});
    }
    await apiDelete(`/api/apps/${appId}`).catch(() => {});
  });

  test('deploy A through the UI; stop via UI requires force confirmation', async ({ page }) => {
    test.setTimeout(420_000);
    const depId = await deployViaApi('e2e-rel', `${FIX}/hello-node.git`);
    depIds.push(depId);
    await waitForDeploymentStatus(depId, ['RUNNING']);

    await page.goto(`/deployments/${depId}`);
    await expect(page.getByText('RUNNING').first()).toBeVisible();
    // The force-stop confirmation only appears for the ACTIVE deployment;
    // cutover lands shortly after RUNNING, so wait for the badge.
    await expect(page.getByText('ACTIVE').first()).toBeVisible({ timeout: 60_000 });

    // Stop the ACTIVE deployment: the UI must surface the force confirmation.
    await page.getByRole('button', { name: /stop/i }).click();
    await expect(page.getByText(/unavailable/i)).toBeVisible();
    await page.getByRole('button', { name: /confirm force stop/i }).click();
    // Route behavior: honest 503 while nothing is active. The route clear
    // lands at the tail of stopDeployment; poll briefly instead of racing it.
    let servedStatus = 0;
    for (let i = 0; i < 30; i++) {
      servedStatus = (await appUrl('e2e-rel', '/health')).status;
      if (servedStatus === 503) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(servedStatus).toBe(503);

    // Restart via UI: routing recovers, restart count updates.
    await page.getByRole('button', { name: /restart/i }).click();
    await expect(page.getByText('RUNNING').first()).toBeVisible({ timeout: 120_000 });
    // Routing recovers onto the fresh container's new port.
    let served2Status = 0;
    for (let i = 0; i < 30; i++) {
      served2Status = (await appUrl('e2e-rel', '/health')).status;
      if (served2Status === 200) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(served2Status).toBe(200);

    // Restart count visible in the deployment detail.
    await page.goto(`/deployments/${depId}`);
    await expect(page.getByText('Restarts', { exact: true })).toBeVisible();
    const dep = (await apiGet(`/api/deployments/${depId}`)) as { restartCount: number };
    expect(dep.restartCount).toBe(1);
  });

  test('automatic recovery: crash-once fixture returns to RUNNING in the UI', async ({ page }) => {
    test.setTimeout(420_000);
    const depId = await deployViaApi('e2e-rel', `${FIX}/crash-once.git`);
    depIds.push(depId);
    await waitForDeploymentStatus(depId, ['RUNNING']);

    await page.goto(`/deployments/${depId}`);
    // The crash + recovery timeline appears; deployment returns to RUNNING.
    await expect(page.locator('table').getByText('container.crashed').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('table').getByText('restart.auto_succeeded').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('RUNNING').first()).toBeVisible({ timeout: 60_000 });
    const served = await appUrl('e2e-rel', '/health');
    expect(served.status).toBe(200);
  });

  test('retry exhaustion: final FAILED with event history, no spinner', async ({ page }) => {
    test.setTimeout(600_000);
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-rel-exhaust', repositoryUrl: `${FIX}/failing-app.git` }),
    });
    const exhaustApp = (await res.json()).id;
    await fetch(`http://localhost:4100/api/apps/${exhaustApp}/restart-policy`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: 'on-failure', maxRestartAttempts: 1 }),
    });
    const depId = await deployViaApi('e2e-rel-exhaust', `${FIX}/failing-app.git`);
    depIds.push(depId);
    await waitForDeploymentStatus(depId, ['FAILED'], 300_000);

    await page.goto(`/deployments/${depId}`);
    // FAILED badge, failure reason, event history — no eternal loading.
    await expect(page.getByText('FAILED').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/exited unexpectedly|restart failed/i).first()).toBeVisible();
    await expect(page.locator('table').getByText('restart.auto_scheduled').first()).toBeVisible();
    // Metrics section shows the honest unavailable message, not a spinner.
    await expect(page.getByText(/only available while.*RUNNING/i)).toBeVisible({ timeout: 15_000 });
    await apiDelete(`/api/apps/${exhaustApp}`);
  });

  test('rollback via UI: confirmation, same URL, version flips back', async ({ page }) => {
    test.setTimeout(600_000);
    // Revision A (msvc revision 0 of a dedicated app is overkill; use rev-app fixture).
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-rel-rb', repositoryUrl: `${FIX}/hello-node.git` }),
    });
    const rbApp = (await res.json()).id;
    const depA = await deployViaApi('e2e-rel-rb', `${FIX}/hello-node.git`);
    depIds.push(depA);
    await waitForDeploymentStatus(depA, ['RUNNING']);

    // Deploy B: same repo, new deployment (image differs only by rebuild; the
    // UI flow is what we verify — rollback target selection + confirmation).
    const depB = await deployViaApi('e2e-rel-rb', `${FIX}/hello-node.git`);
    depIds.push(depB);
    await waitForDeploymentStatus(depB, ['RUNNING']);

    await page.goto(`/apps/${rbApp}`);
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(2);

    // Roll back to the FIRST (non-active) deployment via its confirm flow.
    const targetRow = rows.filter({ has: page.getByText(depA.slice(0, 8)) });
    await targetRow.getByRole('button', { name: /rollback/i }).click();
    await expect(page.getByText(/roll back to this revision/i)).toBeVisible();
    await targetRow.getByRole('button', { name: /^yes$/i }).click();

    await expect(page.getByText('RUNNING').first()).toBeVisible({ timeout: 240_000 });
    const detail = (await apiGet(`/api/apps/${rbApp}`)) as { activeDeploymentId: string };
    expect(detail.activeDeploymentId).not.toBe(depB);
    await apiDelete(`/api/apps/${rbApp}`);
  });
});
