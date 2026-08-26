// Git auto-deploy + GitHub pull-request previews (v0.7).
//
// Security model (unchanged in spirit, extended for PRs):
//  - Webhook signatures are HMAC-SHA256, verified against the matched
//    application's configured secret. Payload repository identifiers are used
//    ONLY to look up an existing MiniCloud application; they can never create
//    one or select an arbitrary app by id.
//  - Deliveries are deduplicated by X-GitHub-Delivery id (GitHub retries are
//    safe; replays of already-processed deliveries are no-ops).
//  - Preview route keys derive from the APPLICATION's slug + PR number — never
//    from payload-controlled strings.
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  AppRepository,
  DeploymentRepository,
  DeploymentEventRepository,
  JOB_PRIORITY,
  PreviewRepository,
  WebhookDeliveryRepository,
} from '@minicloud/db';
import { DeploymentEngine, DeploymentQueue } from '@minicloud/deployment-engine';
import { lsRemoteSha } from '@minicloud/deployment-engine';

export interface AutoDeployDeps {
  apps: AppRepository;
  deployments: DeploymentRepository;
  events: DeploymentEventRepository;
  engine: DeploymentEngine;
  queue: DeploymentQueue;
  previews: PreviewRepository;
  deliveries: WebhookDeliveryRepository;
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
interface PullRequestPayload {
  action?: string;
  number?: number;
  pull_request?: {
    number?: number;
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
    merged?: boolean;
  };
}

/**
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

  await deps.apps.setObservedSha(appId, sha);

  // NOTE: app-scoped signals are NOT written to deployment_events (its FK is
  // deployment-keyed); superseding emits queue.superseded per affected
  // deployment inside the queue's enqueue path instead.
  const { deploymentId } = await deps.queue.createAndEnqueue(appId, {
    trigger: 'git',
    priority: JOB_PRIORITY.git,
    desiredRef: sha,
    commitSha: sha,
  });
  await deps.events.append(deploymentId, 'git.deploy_started', `${sha.slice(0, 12)} (${source})`, {
    sha, source, branch: app.git_branch,
  });
  return deploymentId;
}

const normRepo = (s: string) => s.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();

/** Deterministic, collision-safe preview hostname label. */
export function previewRouteSlug(prNumber: number, appSlug: string): string {
  // pr-<n>-<slug>; slug part truncated to keep the label <= 63 chars.
  const budget = 63 - `pr-${prNumber}-`.length;
  return `pr-${prNumber}-${appSlug.slice(0, budget)}`;
}

async function handlePullRequest(
  deps: AutoDeployDeps,
  appId: string,
  payload: PullRequestPayload,
): Promise<{ handled: boolean; detail?: string }> {
  const action = payload.action ?? '';
  const prNumber = payload.number ?? payload.pull_request?.number;
  if (!prNumber || !['opened', 'reopened', 'synchronize', 'closed'].includes(action)) {
    return { handled: false, detail: `action "${action}" ignored` };
  }
  const env = await deps.previews.byAppAndPr(appId, prNumber);

  if (action === 'closed') {
    if (!env || env.status === 'closed') return { handled: false, detail: 'no open preview' };
    // Cancel any queued/running preview work first, then tear down what ran.
    const history = await deps.deployments.listByPreviewEnvironment(env.id);
    for (const dep of history) {
      if (!['FAILED', 'STOPPED', 'CANCELLED', 'RUNNING'].includes(dep.status)) {
        await deps.queue.cancelByDeployment(dep.id, 'preview closed').catch(() => {});
      }
    }
    if (env.active_preview_deployment_id) {
      await deps.engine.teardownPreviewDeployment(env.active_preview_deployment_id);
    }
    const lastDep = history[history.length - 1]?.id;
    if (lastDep) {
      await deps.events.append(lastDep, 'preview.closed', `PR #${prNumber}`, {
        prNumber,
        previewEnvironmentId: env.id,
      });
    }
    return { handled: true, detail: 'preview closed' };
  }

  // opened / reopened / synchronize → deploy or replace the preview.
  const headSha = payload.pull_request?.head?.sha ?? null;
  // GitHub always sends a full object id; anything else is rejected before it
  // can become a git argument (defence against option-style values).
  if (!headSha || !/^[0-9a-f]{40}$/i.test(headSha)) {
    return { handled: false, detail: 'missing or malformed head sha' };
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0 || prNumber > 2_147_483_647) {
    return { handled: false, detail: 'malformed pr number' };
  }
  const branch = payload.pull_request?.head?.ref ?? null;
  const app = await deps.apps.byId(appId);
  if (!app) return { handled: false, detail: 'application vanished' };
  const routeSlug = previewRouteSlug(prNumber, app.route_slug ?? app.name);
  const logical = await deps.previews.upsert(appId, prNumber, { headSha, branch, routeSlug });
  const { deploymentId } = await deps.queue.createAndEnqueue(appId, {
    trigger: 'preview',
    priority: JOB_PRIORITY.preview,
    desiredRef: headSha,
    commitSha: headSha,
    previewEnvironmentId: logical.id,
    gatewayRouteKey: routeSlug,
  });
  // Event keyed to the NEW deployment (deployment_events is deployment-scoped).
  await deps.events.append(
    deploymentId,
    action === 'synchronize' ? 'preview.updating' : 'preview.creating',
    `PR #${prNumber} @ ${headSha.slice(0, 12)}`,
    { prNumber, headSha, branch, previewEnvironmentId: logical.id },
  );
  return { handled: true, detail: deploymentId };
}


export function registerAutoDeployRoutes(
  app: FastifyInstance,
  deps: AutoDeployDeps,
): void {
  // GitHub webhook endpoint (push events + pull_request preview lifecycle).
  app.post('/api/webhook', async (req, reply) => {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const event = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    const payload = req.body as {
      repository?: { full_name?: string; clone_url?: string; html_url?: string };
      ref?: string;
      after?: string;
    } & PullRequestPayload;
    if (!payload.repository) {
      return reply.code(200).send({ ok: true, ignored: true });
    }

    // Find the matching application by repository full_name or clone URL
    // (normalized). Unverified payload values can never mint new apps/routes.
    const repoUrlCandidates = [
      payload.repository.clone_url,
      payload.repository.html_url ? `${payload.repository.html_url}.git` : undefined,
    ].filter(Boolean) as string[];
    const allApps = await deps.apps.list();
    const match = allApps.find((a) =>
      repoUrlCandidates.some((u) => normRepo(a.repository_url) === normRepo(u)),
    );
    if (!match) {
      return reply.code(200).send({ ok: true, ignored: 'no matching application' });
    }

    // Validate signature using the app's webhook secret BEFORE trusting any
    // further payload content.
    if (!match.webhook_secret || !verifyWebhookSignature(body, signature, match.webhook_secret)) {
      // No deployment exists to attach an event to; rejection is observable
      // via the 403 and server logs. Never 500 on unauthenticated input.
      req.log.warn({ appId: match.id }, 'webhook rejected: invalid or missing signature');
      return reply.code(403).send({ error: 'Invalid webhook signature' });
    }

    // Delivery dedup: GitHub retries redeliver the same GUID. Insert-once
    // makes every handler below retry-safe; unknown-format ids still dedup.
    if (deliveryId) {
      const first = await deps.deliveries.beginOnce(deliveryId, event ?? null).catch(() => true);
      if (!first) {
        return reply.code(200).send({ ok: true, ignored: 'duplicate delivery' });
      }
    }

    if (event === 'pull_request') {
      const result = await handlePullRequest(deps, match.id, payload).catch((err) => {
        app.log.warn({ err }, 'pull_request handling failed');
        return { handled: false, detail: 'internal error' };
      });
      return reply.code(200).send(result.handled ? { ok: true, deploymentId: result.detail } : { ok: true, ignored: result.detail });
    }
    if (event !== 'push') {
      return reply.code(200).send({ ok: true, ignored: `event "${event}" not handled` });
    }

    // ---- push events -------------------------------------------------------
    const branch = (payload.ref ?? '').replace('refs/heads/', '');
    if (branch !== match.git_branch) {
      return reply.code(200).send({ ok: true, ignored: `branch "${branch}" does not match tracked "${match.git_branch}"` });
    }
    const sha = payload.after;
    if (!sha || sha === '0000000000000000000000000000000000000000') {
      return reply.code(200).send({ ok: true, ignored: 'branch deletion' });
    }

    const deploymentId = await maybeAutoDeploy(deps, match.id, sha, 'webhook');
    return reply.code(202).send({ ok: true, deploymentId });
  });

  // Manual sync: poll the remote for a new SHA and deploy if changed.
  app.post('/api/apps/:id/sync', async (req, reply) => {
    const { id } = req.params as { id: string };
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
