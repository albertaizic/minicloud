import { test, expect } from '@playwright/test';
import { attachErrorCollectors, expectNoErrors, apiGet, apiDelete } from '../helpers/support.js';

const REPO = 'http://127.0.0.1:4555/hello-node.git';
let appId: string;

test.describe.serial('configuration UI (env, secrets, limits, policy)', () => {
  test.beforeAll(async ({ browser }) => {
    const res = await fetch('http://localhost:4100/api/apps', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-config', repositoryUrl: REPO }),
    });
    appId = (await res.json()).id;
  });

  test.afterAll(async () => {
    if (appId) await apiDelete(`/api/apps/${appId}`);
  });

  test('environment variables: add, verify, remove', async ({ page }) => {
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    await page.goto(`/apps/${appId}`);
    const panel = page.locator('h2:has-text("Configuration") + * ~ *').first();

    await page.getByPlaceholder('KEY').first().fill('E2E_VAR');
    await page.getByPlaceholder('value').first().fill('e2e-value-123');
    await page.getByRole('button', { name: /set variable/i }).click();
    await expect(page.locator('tbody').getByText('E2E_VAR')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('tbody').getByText('e2e-value-123')).toBeVisible();

    // Update the value.
    await page.getByPlaceholder('KEY').first().fill('E2E_VAR');
    await page.getByPlaceholder('value').first().fill('updated-456');
    await page.getByRole('button', { name: /set variable/i }).click();
    await expect(page.locator('tbody').getByText('updated-456')).toBeVisible({ timeout: 10_000 });

    // API agrees.
    const env = (await apiGet(`/api/apps/${appId}/env`)).variables as Array<{ key: string; value: string }>;
    expect(env.find((v) => v.key === 'E2E_VAR')?.value).toBe('updated-456');

    // Remove.
    const row = page.locator('tr', { hasText: 'E2E_VAR' });
    await row.getByRole('button', { name: /delete/i }).click();
    await expect(page.locator('tbody').getByText('E2E_VAR')).toHaveCount(0, { timeout: 10_000 });
    expectNoErrors(consoleErrors, pageErrors);
  });

  test('secrets: masked in DOM, never returned, replace + delete work', async ({ page }) => {
    const secretValue = 'e2e-super-secret-99';
    await page.goto(`/apps/${appId}`);
    const secretKey = page.getByPlaceholder('KEY').nth(1);
    await secretKey.fill('E2E_SECRET');
    await page.getByPlaceholder('secret value').fill(secretValue);
    await page.getByRole('button', { name: /store secret/i }).click();
    await expect(page.locator('tbody').getByText('E2E_SECRET')).toBeVisible({ timeout: 10_000 });

    // Masked representation — the plaintext must never appear in the DOM.
    await expect(page.locator('tbody').getByText(secretValue)).toHaveCount(0);
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain(secretValue);

    // API never returns it.
    const env = (await apiGet(`/api/apps/${appId}/env`)) as {
      secrets: Array<{ key: string }>; variables: Array<{ key: string; value: string }>;
    };
    expect(env.secrets.map((s) => s.key)).toContain('E2E_SECRET');
    expect(JSON.stringify(env)).not.toContain(secretValue);

    // Replace: still masked, still one entry.
    await page.getByPlaceholder('KEY').nth(1).fill('E2E_SECRET');
    await page.getByPlaceholder('secret value').fill('replaced-secret-42');
    await page.getByRole('button', { name: /store secret/i }).click();
    await expect(page.locator('tbody').getByText('E2E_SECRET')).toBeVisible();
    const replaced = (await apiGet(`/api/apps/${appId}/env`)).secrets;
    expect(replaced).toHaveLength(1);

    // Delete.
    const row = page.locator('tr', { hasText: 'E2E_SECRET' });
    await row.getByRole('button', { name: /delete/i }).click();
    await expect(page.locator('tbody').getByText('E2E_SECRET')).toHaveCount(0, { timeout: 10_000 });
  });

  test('resource limits: set, persist, verify against real Docker cgroups', async ({ page }) => {
    await page.goto(`/apps/${appId}`);
    await page.getByPlaceholder('memory MB (16–65536)').fill('256');
    await page.getByPlaceholder('CPUs (0.1–64)').fill('0.5');
    await page.getByRole('button', { name: /save limits/i }).click();
    await expect(page.getByText(/memory 256 MB/i)).toBeVisible({ timeout: 10_000 });

    // API + Docker agree.
    const limits = (await apiGet(`/api/apps/${appId}/limits`)) as { memoryLimitMb: number; cpuLimit: number };
    expect(limits).toEqual({ memoryLimitMb: 256, cpuLimit: 0.5 });

    // Deploy and verify the REAL container cgroup values.
    const dres = await fetch(`http://localhost:4100/api/apps/${appId}/deploy`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const { deployment } = await dres.json();
    const start = Date.now();
    for (;;) {
      const d = (await apiGet(`/api/deployments/${deployment.id}`)) as {
        status: string; containerName: string | null;
      };
      if (d.status === 'RUNNING') break;
      if (Date.now() - start > 240_000) throw new Error('deployment never reached RUNNING');
      await new Promise((r) => setTimeout(r, 1500));
    }
    const detail = (await apiGet(`/api/apps/${appId}`)) as {
      activeDeploymentId: string;
      deployments: Array<{ id: string; containerName: string | null }>;
    };
    const containerName = detail.deployments.find((d) => d.id === detail.activeDeploymentId)!.containerName!;
    const inspect = JSON.parse(
      new TextDecoder().decode(
        require('node:child_process').execSync(
          `docker inspect ${containerName} --format "{{json .HostConfig.Memory}},{{json .HostConfig.NanoCpus}}"`,
        ),
      ).toString().split('\n').filter(Boolean).pop()!,
    ) as [number, number];
    expect(inspect[0]).toBe(256 * 1024 * 1024);
    expect(inspect[1]).toBe(500_000_000);
    await apiDelete(`/api/deployments/${detail.activeDeploymentId}?force=true`);
  });

  test('restart policy: set, persist across reload, invalid values rejected', async ({ page }) => {
    await page.goto(`/apps/${appId}`);
    await page.locator('select').selectOption('on-failure');
    await page.locator('input[type="number"]').last().fill('4');
    await page.getByRole('button', { name: /save policy/i }).click();
    await expect(page.getByText('saved')).toBeVisible({ timeout: 10_000 });

    // Reload: UI state consistent.
    await page.reload();
    await expect(page.locator('select')).toHaveValue('on-failure');
    await expect(page.locator('input[type="number"]').last()).toHaveValue('4');

    // API agrees.
    expect(await apiGet(`/api/apps/${appId}/restart-policy`)).toEqual({
      policy: 'on-failure', maxRestartAttempts: 4,
    });

    // Invalid attempt count is rejected with a visible error, no crash.
    await page.locator('input[type="number"]').last().fill('99');
    await page.getByRole('button', { name: /save policy/i }).click();
    await expect(page.locator('p.error')).toBeVisible();
    await page.reload();
  });
});
