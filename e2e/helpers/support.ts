import { expect, type Page } from '@playwright/test';
import http from 'node:http';

export const API = 'http://localhost:4100';
export const GW_PORT = 8080;

export function appUrl(slug: string, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: GW_PORT, path, headers: { host: `${slug}.localhost` } },
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

export async function apiGet(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`);
  return res.json();
}

export async function apiDelete(path: string): Promise<number> {
  const res = await fetch(`${API}${path}`, { method: 'DELETE' });
  return res.status;
}

/** Wait until the deployment reaches one of the given statuses via the API. */
export async function waitForDeploymentStatus(
  deploymentId: string,
  statuses: string[],
  timeoutMs = 240_000,
): Promise<string> {
  const start = Date.now();
  for (;;) {
    const d = await apiGet(`/api/deployments/${deploymentId}`);
    if (statuses.includes(d.status)) return d.status;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`deployment ${deploymentId.slice(0, 8)} stuck at ${d.status}: ${d.failureReason ?? ''}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/** Find-or-create an application by name: fixture isolation that tolerates
 *  leftover state from a previous run without masking real API failures. */
export async function ensureApp(name: string, repoUrl: string): Promise<string> {
  const apps = (await apiGet('/api/apps')) as Array<{ id: string; name: string }>;
  const existing = apps.find((a) => a.name === name);
  if (existing) return existing.id;
  const res = await fetch(`${API}/api/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, repositoryUrl: repoUrl }),
  });
  const app = await res.json();
  if (!res.ok || !app.id) throw new Error(`create app failed: ${JSON.stringify(app)}`);
  return app.id as string;
}

/** Create (or reuse) an app + deploy through the API (dashboard asserts the UI side). */
export async function deployViaApi(name: string, repoUrl: string, ref?: string): Promise<string> {
  const appId = await ensureApp(name, repoUrl);
  const dres = await fetch(`${API}/api/apps/${appId}/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(ref ? { ref } : {}),
  });
  const body = await dres.json();
  if (!dres.ok || !body.deployment?.id) throw new Error(`deploy failed: ${JSON.stringify(body)}`);
  return body.deployment.id;
}

/** Collect console errors + page errors on a page for the whole test. */
export function attachErrorCollectors(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  return { consoleErrors, pageErrors };
}

export function expectNoErrors(consoleErrors: string[], pageErrors: string[]): void {
  const ignorable = (t: string) =>
    // React DevTools suggestion and favicon are noise, not product errors.
    /Download the React DevTools|Failed to load resource.*favicon/i.test(t);
  const realConsole = consoleErrors.filter((t) => !ignorable(t));
  expect(realConsole, `console errors: ${JSON.stringify(realConsole)}`).toHaveLength(0);
  expect(pageErrors, `uncaught page errors: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
}
