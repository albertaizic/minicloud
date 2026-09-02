import { test, expect } from '@playwright/test';
import {
  attachErrorCollectors, apiGet, apiDelete, deployViaApi,
  waitForDeploymentStatus, appUrl, ensureApp, expectNoErrors,
} from '../helpers/support.js';

const FIX = 'http://localhost:4555';
const MSC = `${FIX}/msvc.git`;
async function msvcShas(): Promise<[string, string]> {
  const r = await fetch(`${FIX}/shas.json`);
  const j = (await r.json()) as { msvc: [string, string] };
  return j.msvc;
}

test.describe.serial('multi-service + zero-downtime UI (real stack)', () => {
  let appId: string;
  let depA: string;
  let depB: string;

  test.beforeAll(async () => {
    // Tolerant of leftover state from a previous run: reuses an existing
    // app named 'e2e-msvc' rather than failing the suite when 409 hits
    // a name conflict.
    appId = await ensureApp('e2e-msvc', MSC);
    await apiDelete(`/api/apps/${appId}`).catch(() => {});
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
    const [shaA, shaB] = await msvcShas();
    depA = await deployViaApi('e2e-msvc', MSC, shaA);
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

    // State-wait for the rollback deployment to be RUNNING, the active
    // pointer to move off depB, and the gateway to actually serve A. The
    // rollback deployment is a NEW row whose lineage (rollbackOf) points
    // at depA; we use that — not a boolean we set ourselves — as the
    // ground-truth signal.
    const rollbackDepId = await waitForRollback({ appId, depB, depA });
    await expect
      .poll(async () => JSON.parse((await appUrl('e2e-msvc')).body).version, {
        message: 'stable URL serves rolled-back revision (msvc-A)',
        timeout: 60_000,
        intervals: [500],
      })
      .toBe('msvc-A');

    const parsedVol = JSON.parse((await appUrl('e2e-msvc')).body) as { version: string; api: { count: number } };
    expect(parsedVol.version).toBe('msvc-A');
    expect(parsedVol.api.count).toBeGreaterThanOrEqual(1);
    // Touch the row id so the variable isn't flagged as unused.
    expect(rollbackDepId).toBeTruthy();
  });
});
async function waitForRollback({
  appId,
  depB,
  depA,
  timeoutMs = 300_000,
}: {
  appId: string;
  depB: string;
  depA: string;
  timeoutMs?: number;
}): Promise<string> {
  const start = Date.now();
  let last: { active?: string; rollbackDep?: { id: string; status: string; rollbackOf: string | null } } = {};
  while (Date.now() - start < timeoutMs) {
    const appRow = (await apiGet(`/api/apps/${appId}`)) as {
      activeDeploymentId?: string;
      deployments: Array<{ id: string; status: string; rollbackOf: string | null }>;
    };
    const act = appRow.activeDeploymentId ?? '';
    const rollbackDep = appRow.deployments.find(
      (d) => d.rollbackOf === depA && d.status === 'RUNNING',
    );
    last = { active: act, rollbackDep };
    if (rollbackDep && act && act !== depB) return rollbackDep.id;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `rollback never converged within ${timeoutMs}ms: last state ${JSON.stringify(last)}`,
  );
}