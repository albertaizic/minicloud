// Git auto-deploy: webhook endpoint + polling sync.
// Security: webhook signatures validated with HMAC-SHA256; payloads can only
// trigger deployments for applications already configured with a matching
// repository URL + branch. No request input ever reaches a shell or Docker
// command argument unsanitized.
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AppRepository,
  DeploymentRepository,
  DeploymentEventRepository,
} from '@minicloud/db';
import { DeploymentEngine } from '@minicloud/deployment-engine';
import { lsRemoteSha } from '@minicloud/deployment-engine';

export interface AutoDeployDeps {
  apps: AppRepository;
  deployments: DeploymentRepository;
  events: DeploymentEventRepository;
  engine: DeploymentEngine;
}

/** Verify GitHub webhook signature (HMAC-SHA256 hex digest). */
export function verifyWebhookSignature(
  payload: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const received = signature.slice('sha256='.length);
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
}

/**
 * Trigger a deployment for a new SHA if:
 *  - auto-deploy is enabled
 *  - the SHA differs from the last deployed SHA
 *  - no newer deployment for the same app is already in progress
 * Returns the deployment id or null when skipped.
 */
export async function maybeAutoDeploy(
  deps: AutoDeployDeps,
  appId: string,
  sha: string,
  source: 'webhook' | 'polling',
): Promise<string | null> {
  const app = await deps.apps.byId(appId);
  if (!app || !app.auto_deploy) return null;
  if (app.last_deployed_sha === sha) return null; // already deployed this SHA

  await deps.events.append(appId, 'git.commit_detected', `${sha.slice(0, 12)} on ${app.git_branch}`, {
    sha, branch: app.git_branch, source,
  });
  await deps.apps.setObservedSha(appId, sha);

  // Guard: don't deploy if a newer deployment for this app is in flight.
  const latest = await deps.deployments.latestForApp(appId);
  if (latest && !['RUNNING', 'FAILED', 'STOPPED'].includes(latest.status)) {
    await deps.events.append(appId, 'git.deploy_superseded', `${sha.slice(0, 12)} skipped; deployment in progress`, { sha });
    return null;
  }

  await deps.events.append(appId, 'git.deploy_queued', `${sha.slice(0, 12)}`, { sha });
  const dep = await deps.deployments.create(appId, { ref: sha, commitSha: sha });
  await deps.events.append(dep.id, 'git.deploy_started', `${sha.slice(0, 12)}`, { sha });
  void deps.engine.runDeployment(dep.id).catch((err) => {
    deps.events.append(dep.id, 'git.deploy_failed', String(err).slice(0, 300), { sha }).catch(() => {});
  });
  return dep.id;
}

export function registerAutoDeployRoutes(
  app: FastifyInstance,
  deps: AutoDeployDeps,
): void {
  // GitHub webhook endpoint.
  app.post('/api/webhook', async (req, reply) => {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as string | undefined;

    // Find the matching application by repository full_name or clone_url.
    const payload = req.body as {
      repository?: { full_name?: string; clone_url?: string; html_url?: string };
      ref?: string;
      after?: string;
    };
    if (!payload.repository || event !== 'push') {
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const repoUrlCandidates = [
      payload.repository.clone_url,
      payload.repository.html_url ? `${payload.repository.html_url}.git` : undefined,
    ].filter(Boolean) as string[];

    // Find the app whose repository_url matches (normalized).
    const allApps = await deps.apps.list();
    const match = allApps.find((a) =>
      repoUrlCandidates.some((u) => {
        const norm = (s: string) => s.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
        return norm(a.repository_url) === norm(u);
      }),
    );
    if (!match) {
      return reply.code(200).send({ ok: true, ignored: 'no matching application' });
    }

    // Validate signature using the app's webhook secret.
    if (!match.webhook_secret || !verifyWebhookSignature(body, signature, match.webhook_secret)) {
      await deps.events.append(match.id, 'webhook.rejected', 'invalid or missing signature');
      return reply.code(403).send({ error: 'Invalid webhook signature' });
    }

    // Branch check.
    const branch = (payload.ref ?? '').replace('refs/heads/', '');
    if (branch !== match.git_branch) {
      return reply.code(200).send({ ok: true, ignored: `branch "${branch}" does not match tracked "${match.git_branch}"` });
    }

    const sha = payload.after;
    if (!sha || sha === '0000000000000000000000000000000000000000') {
      return reply.code(200).send({ ok: true, ignored: 'branch deletion' });
    }

    await deps.events.append(match.id, 'webhook.received', `${event} ${branch} ${sha.slice(0, 12)}`, { sha, branch });
    const deploymentId = await maybeAutoDeploy(deps, match.id, sha, 'webhook');
    return reply.code(202).send({ ok: true, deploymentId });
  });

  // Manual sync: poll the remote for a new SHA and deploy if changed.
  app.post('/api/apps/:id/sync', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { lsRemoteSha } = await import('@minicloud/deployment-engine');
    const appRow = await deps.apps.byId(id);
    if (!appRow) return reply.code(404).send({ error: 'Application not found' });

    const { sha, error } = await lsRemoteSha(appRow.repository_url, appRow.git_branch);
    if (error || !sha) {
      return reply.code(502).send({ error: error ?? 'failed to check remote' });
    }
    await deps.apps.setObservedSha(id, sha);
    if (sha === appRow.last_deployed_sha) {
      return reply.code(200).send({ upToDate: true, sha });
    }
    if (!appRow.auto_deploy) {
      return reply.code(200).send({ upToDate: false, sha, message: 'auto-deploy is disabled' });
    }
    const deploymentId = await maybeAutoDeploy(deps, id, sha, 'polling');
    return reply.code(202).send({ upToDate: false, sha, deploymentId });
  });
}
