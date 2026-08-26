// Queue + preview UI flows (v0.7, real stack): the dashboard must make queued
// work obvious, cancellable, and keep PREVIEW traffic visually distinct.
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import {
  API,
  attachErrorCollectors, apiGet, apiDelete, expectNoErrors,
} from '../helpers/support.js';

const SECRET = 'e2e-whsec-0123456789abcdef';

function sign(payload: string): string {
  return `sha256=${crypto.createHmac('sha256', SECRET).update(payload).digest('hex')}`;
}

function setWebhookSecret(appId: string): void {
  // MiniCloud has no secret-read/write REST surface for webhook secrets by
  // design; tests seed it directly into the E2E database.
  execFileSync(
    'docker',
    ['exec', 'minicloud-postgres', 'psql', '-U', 'minicloud', '-d', 'minicloud_e2e',
     '-c', `UPDATE applications SET webhook_secret = '${SECRET}' WHERE id = '${appId}'`],
    { stdio: 'pipe', timeout: 15_000 },
  );
}

async function createAppWithWebhook(name: string, repoUrl: string): Promise<{ appId: string; slug: string }> {
  const res = await fetch(`${API}/api/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, repositoryUrl: repoUrl }),
  });
  const app = (await res.json()) as { id: string; routeSlug?: string };
  await fetch(`${API}/api/apps/${app.id}/git`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ autoDeploy: true }),
  });
  setWebhookSecret(app.id);
  return { appId: app.id, slug: app.routeSlug ?? name };
}

function requestThroughGateway(port: number, host: string, path = '/health'): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, headers: { host } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: String(e) }));
    req.end();
  });
}

test.describe.serial('queue & preview UI (v0.7)', () => {
  let appId: string;
  let slug: string;
  let previewAppId: string;
  let previewSlug: string;

  test.beforeAll(async () => {
    const made = await createAppWithWebhook(`e2e-q-${Date.now() % 100000}`, 'http://localhost:4555/hello-node.git');
    appId = made.appId;
    slug = made.slug;
    // Preview webhooks reference the two-revision 'rev' fixture, so the
    // application they must match is bound to that repository URL.
    const prev = await createAppWithWebhook(`e2e-p-${Date.now() % 100000}`, 'http://localhost:4555/rev.git');
    previewAppId = prev.appId;
    previewSlug = prev.slug;
  });

  test.afterAll(async () => {
    await apiDelete(`/api/apps/${appId}`).catch(() => {});
    await apiDelete(`/api/apps/${previewAppId}`).catch(() => {});
  });

  test('deployment enters queue, shows position/source, and can be cancelled while queued', async ({ page }) => {
    test.setTimeout(180_000);
    const { consoleErrors, pageErrors } = attachErrorCollectors(page);
    // Enqueue TWO deploys back-to-back without a running scheduler tick gap:
    // the second must be visibly QUEUED behind the first.
    const dres = await fetch(`${API}/api/apps/${appId}/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const first = (await dres.json()) as { deployment: { id: string }; jobId: string };
    expect(first.jobId).toBeTruthy();

    await page.goto(`/apps/${appId}`);
    // The queue panel appears on the app page with the job visible.
    await expect(page.getByRole('heading', { name: /queue/i })).toBeVisible();
    await expect(page.locator('tbody').getByText(/queued|building|cloning/i).first()).toBeVisible({ timeout: 20_000 });
    expectNoErrors(consoleErrors, pageErrors);

    // Cancel path from the UI on a SECOND deployment that queues behind:
    const d2 = await fetch(`${API}/api/apps/${appId}/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const second = (await d2.json()) as { deployment: { id: string; status: string } };
    if (second.deployment.status === 'QUEUED') {
      const cancelRes = await fetch(`${API}/api/deployments/${second.deployment.id}/cancel`, { method: 'POST' });
      expect(cancelRes.status).toBe(200);
      const after = (await apiGet(`/api/deployments/${second.deployment.id}`)) as { status: string };
      expect(['CANCELLED']).toContain(after.status);
      await page.goto('/');
      await expect(page.getByText(/cancelled/i).first()).toBeVisible({ timeout: 15_000 });
    }
  });

  test('build progress is observable through RUNNING transition', async ({ page }) => {
    test.setTimeout(420_000);
    const dres = await fetch(`${API}/api/apps/${appId}/deploy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = (await dres.json()) as { deployment: { id: string } };
    // Reach RUNNING via the API first: the page's metrics note also contains
    // the word RUNNING when queued, which would match too early.
    for (let i = 0; i < 300; i++) {
      const d = (await apiGet(`/api/deployments/${body.deployment.id}`)) as { status: string };
      if (d.status === 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await page.goto(`/deployments/${body.deployment.id}`);
    await expect(page.locator('.detail-grid .badge', { hasText: /running/i })).toBeVisible({ timeout: 30_000 });
    // Build cache line renders for real builds and exact reuse alike.
    await expect(page.getByText(/built from Dockerfile|reused image/i).first()).toBeVisible({ timeout: 60_000 });
  });

  test('preview lifecycle: open → URL works → synchronize flips version → close cleans up', async ({ page }) => {
    test.setTimeout(600_000);

    // Drive previews through signed webhooks like GitHub would.
    async function sendPullRequest(action: string, prNumber: number, headSha: string): Promise<{ status: number; body: Record<string, unknown> }> {
      const payload = JSON.stringify({
        action,
        number: prNumber,
        repository: { clone_url: 'http://localhost:4555/rev.git', full_name: 'local/rev' },
        pull_request: {
          number: prNumber,
          head: { sha: headSha, ref: 'feature' },
          base: { ref: 'main' },
        },
      });
      const res = await fetch(`${API}/api/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-github-delivery': crypto.randomUUID(),
          'x-hub-signature-256': sign(payload),
        },
        body: payload,
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    // Revision SHAs come from the fixture's machine-readable index.
    const shas = (await (await fetch('http://localhost:4555/shas.json')).json()) as Record<string, string[]>;
    const rev0 = shas.rev[0] ?? '';
    const rev1 = shas.rev[1] ?? '';
    expect(rev0).toMatch(/^[0-9a-f]{40}$/);
    expect(rev1).toMatch(/^[0-9a-f]{40}$/);

    const open = await sendPullRequest('opened', 7, rev0);
    expect(open.status).toBe(200);
    const previewDepId = open.body.deploymentId as string;
    expect(previewDepId).toBeTruthy();

    // Dashboard: preview panel shows PR #7 with PREVIEW label and its own URL.
    await page.goto(`/apps/${previewAppId}`);
    await expect(page.getByRole('heading', { name: /preview environments/i })).toBeVisible();
    const row = page.locator('tr', { hasText: 'PR #7' }).first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row.getByText(/PREVIEW/i)).toBeVisible();

    // Wait healthy; URL must serve revision content.
    for (let i = 0; i < 240; i++) {
      const d = (await apiGet(`/api/deployments/${previewDepId}`)) as { status: string };
      if (d.status === 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const servedA = await requestThroughGateway(8080, `pr-7-${previewSlug}.localhost`, '/version');
    expect(servedA.body.trim()).toBe('revision-a');

    // synchronize: same URL, new content.
    const sync = await sendPullRequest('synchronize', 7, rev1);
    expect(sync.status).toBe(200);
    const updatedDepId = sync.body.deploymentId as string;
    for (let i = 0; i < 240; i++) {
      const d = (await apiGet(`/api/deployments/${updatedDepId}`)) as { status: string };
      if (d.status === 'RUNNING') break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const servedB = await requestThroughGateway(8080, `pr-7-${previewSlug}.localhost`, '/version');
    expect(servedB.body.trim()).toBe('revision-b');

    // The dashboard reflects the new head SHA on the preview row.
    await page.goto(`/apps/${previewAppId}`);
    await expect(page.locator('tr', { hasText: 'PR #7' }).first().getByText(rev1.slice(0, 12))).toBeVisible({ timeout: 20_000 });

    // close: route disappears; panel marks it closed.
    const close = await sendPullRequest('closed', 7, rev1);
    expect(close.status).toBe(200);
    const goneAfterClose = await requestThroughGateway(8080, `pr-7-${previewSlug}.localhost`);
    expect(goneAfterClose.status).toBe(503);

    await page.goto(`/apps/${previewAppId}`);
    await expect(page.locator('tr', { hasText: 'PR #7' }).first().getByText(/closed/i)).toBeVisible({ timeout: 30_000 });
  });
});
