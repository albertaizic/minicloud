# API & CLI reference (v0.5)

Base URL: `http://localhost:4000` (`PORT` / `HOST` in `.env`).
All bodies are JSON; validation failures return `400` with
`{"error": "...", "details": {field: [messages]}}`.

This page documents the configuration (v0.2) and reliability/observability
(v0.3) endpoints and CLI commands. For the core deployment endpoints see the
[README](../README.md#api-overview).

## Deployment events

Every deployment keeps a persistent, ordered lifecycle history.

```
GET /api/deployments/:id/events
200 {
  "deploymentId": "...",
  "events": [
    { "id": "42", "type": "clone.started", "message": "main",
      "metadata": null, "createdAt": "..." },
    { "id": "43", "type": "build.completed", "message": "minicloud/app-...:d-...",
      "metadata": { "imageTag": "..." }, "createdAt": "..." }
  ]
}
404 unknown deployment | 400 malformed id
```

Event types: `deployment.created`, `clone.started/completed`, `build.started/
completed/skipped`, `container.starting/started/crashed`, `health_check.started/
passed`, `deployment.running/stopped/failed/deleted`, `restart.requested/
attempt/succeeded/failed`, `restart.auto_scheduled/auto_attempt/auto_succeeded/
auto_failed`, `rollback.requested`, `stop.requested`.

Ordering is a monotonic sequence (`id`), not a timestamp. Metadata is
structural context only and never contains secret values.

## Runtime metrics

```
GET /api/deployments/:id/metrics
200 {
  "deploymentId": "...", "status": "RUNNING",
  "restartCount": 1, "autoRestartCount": 1, "startedAt": "...",
  "cpuPercent": 3.2,
  "memoryUsedBytes": 88064, "memoryLimitBytes": 134217728, "memoryPercent": 0.07
}
409 deployment is not RUNNING (or stats temporarily unavailable)
404 unknown deployment
```

Live one-shot Docker stats — CPU% uses docker's own formula, memory subtracts
cache/inactive_file exactly like `docker stats`. No metrics history is stored.

## Rollback

```
POST /api/apps/:id/rollback    body: {"targetDeploymentId": "..."}
202 { "deployment": { ...new deployment... }, "message": "Rollback queued" }
404 target does not exist
409 target belongs to another application | target has no built image |
    target is still in progress | target image gone and commit unknown
400 malformed ids / body
```

Semantics:

- Creates a **new** deployment; historical deployments and their snapshots are
  never modified. The new deployment carries `rollbackOf: <target id>`.
- Reuses the target's Docker image when it still exists (fast path, event
  `build.skipped`); otherwise rebuilds from the target's recorded commit.
- Runs the normal health check; failures mark the new deployment FAILED and
  leave everything else untouched.

## Restart policy

```
GET /api/apps/:id/restart-policy
200 {"policy": "disabled", "maxRestartAttempts": 3}

PUT /api/apps/:id/restart-policy
    body: {"policy": "disabled" | "on-failure", "maxRestartAttempts"?: 0-10}
200 updated policy
400 invalid policy or attempt count
```

Behavior: a RUNNING deployment whose container dies is marked FAILED (exit code
recorded, dead container removed). With `on-failure` and budget remaining, an
automatic restart is scheduled with backoff `min(2^attempt × 2s, 15s)`. Manual
stop cancels pending recovery; manual restart/deploy resets the budget.
Exhaustion is terminal. Stopped or deleted deployments never restart.

## Prune

```
POST /api/prune
200 {"containersRemoved": N, "imagesRemoved": N, "workspacesRemoved": N}
```

Removes only MiniCloud-owned resources: containers of gone/terminal
deployments, `minicloud/app-*` images referenced by no deployment, and
`clone-*` workspace directories older than one hour.

## Application configuration

An application has three configuration surfaces:

1. **Environment variables** — readable, plain values.
2. **Secrets** — write-only, encrypted at rest, injected decrypted into containers.
3. **Resource limits** — Docker cgroup controls for CPU and memory.

Config changes take effect on the **next deploy or restart** (running containers
are not mutated in place).

### List configuration

```
GET /api/apps/:id/env
200 {
  "variables": [{ "key": "LOG_LEVEL", "value": "debug", "updatedAt": "..." }],
  "secrets":   [{ "key": "API_TOKEN", "updatedAt": "..." }]     // keys only, never values
}
```

### Set environment variable

```
PUT /api/apps/:id/env/:key        body: {"value": "..."}
200 {"key": "LOG_LEVEL", "value": "debug", "updatedAt": "..."}
409 key exists as a secret            // delete the secret first
400 invalid key/value
```
Creating/updating with the same key replaces the value.

### Delete environment entry

```
DELETE /api/apps/:id/env/:key
204 deleted (works for both vars and secrets)
404 no entry with that key
```

### Store secret

```
PUT /api/apps/:id/secrets/:key    body: {"value": "..."}
201 {"key": "API_TOKEN"}          // deliberately value-free response
503 MINICLOUD_MASTER_KEY not configured on the API process
409 key exists as a plain variable
400 invalid key/value
```
Re-storing an existing secret replaces its encrypted value. Values are never
returned by any endpoint afterwards.

### Delete secret

```
DELETE /api/apps/:id/secrets/:key
204 | 404 (not found, or key is a plain variable rather than a secret)
```

### Resource limits

```
GET /api/apps/:id/limits
200 {"memoryLimitMb": 256|null, "cpuLimit": 1.5|null}

PUT /api/apps/:id/limits   body: {"memoryLimitMb"?: 16..65536 int, "cpuLimit"?: 0.1..64}
200 updated limits (partial updates keep the other limit)

DELETE /api/apps/:id/limits
200 cleared limits ({null, null})
```

### Deployment snapshots

Every deployment serializes a `config` object:

```json
{
  "config": {
    "env": {"LOG_LEVEL": "debug"},       // plain values only
    "secretKeys": ["API_TOKEN"],         // names only, never values
    "limits": {"memoryLimitMb": 256, "cpuLimit": 1.5}   // or null
  }
}
```

Semantics:

- Created when the container starts; `null` before that.
- A **restart re-resolves current app config** and refreshes this deployment's
  snapshot (the running container matches it again).
- Older deployments are never retroactively changed: history stays immutable.

## CLI

Target API: `MINICLOUD_API_URL` (default `http://localhost:4000`).
`<app>` accepts the app name, an unambiguous id prefix, or a full id.

```
minicloud env <app>                        list env vars (with values) and secret keys (masked)
minicloud env set <app> KEY=VALUE          create/update a variable
minicloud env delete <app> KEY             delete a variable or secret key

minicloud secret set <app> KEY [VALUE]     store/replace a secret;
                                           without VALUE: hidden prompt on a TTY,
                                           piped stdin otherwise (one trailing newline stripped)
minicloud secret delete <app> KEY

minicloud limits show <app>
minicloud limits set <app> [--memory MB] [--cpu CPUS]
minicloud limits clear <app>
```

Examples:

```bash
minicloud env set my-api DATABASE_URL=postgres://db.local/my-api
echo "s3cr3t" | minicloud secret set my-api API_TOKEN
minicloud secret set my-api API_TOKEN        # interactive hidden prompt
minicloud limits set my-api --memory 512 --cpu 0.5
minicloud deploy https://github.com/example/my-api --name my-api
minicloud restart <deployment-id>            # picks up new config without rebuild
```

Exit codes: `0` success, `1` on errors reported by the API or local validation,
`130` when a secret prompt is aborted with Ctrl+C.

## Reliability & observability CLI (v0.3)

```
minicloud events <deployment-id>            chronological lifecycle timeline
minicloud stats <deployment-id> [--watch]   CPU/memory/uptime/restarts snapshot
                                            (--watch refreshes every 2s, Ctrl+C stops)
minicloud rollback <app> <deployment-id>    queue a rollback and wait for it
minicloud restart-policy <app>              show current policy
minicloud restart-policy <app> <disabled|on-failure> [--max N]
minicloud prune [--yes]                     clean unreferenced MiniCloud resources
```

All deployment-id arguments accept unambiguous short prefixes, as everywhere
else in the CLI. `rollback` prints the outcome and exits non-zero if the new
deployment ends in FAILED.

## Dashboard

The application page has:

- a **Restart policy** editor (policy + attempt budget),
- a **Configuration** section: env var table with add/update/delete, write-only
  secrets (masked values, password input), resource limits form,
- the deployment history with **Rollback** buttons (inline confirmation) on
  every deployment that has a built image, and a `↩` marker on rollbacks.

The deployment page shows status/URL/commit/rollback origin, live **metrics**
(CPU, memory, uptime, restarts — polled every 3s only while RUNNING, timers
cleaned up on navigation), the **event timeline**, the configuration snapshot,
and logs.


## Stable URLs, routing and zero-downtime deploys (v0.4)

Every application has a stable endpoint `http://<slug>.localhost:<gateway-port>`
(slug = lowercased app name; gateway port defaults to 8080). The application
serialization carries it:

```json
{
  "routeSlug": "my-api",
  "url": "http://my-api.localhost:8080",
  "activeDeploymentId": "..."
}
```

Deployment serialization carries `isActive` (true for the deployment currently
receiving traffic).

### Routing table

```
GET /api/routes
200 {
  "gatewayPort": 8080,
  "routes": [ { "slug": "my-api", "url": "...", "appId": "...", "appName": "my-api",
                "deploymentId": "...", "upstream": {"host": "127.0.0.1", "port": 33421},
                "activeSince": "...", "stats": {"requests": 120, "active": 0,
                "ok2xx": 118, "client4xx": 2, "server5xx": 0} } ]
}
```

### Zero-downtime semantics

- A new deployment only becomes active after its health check passes AND the
  gateway verifies the route end-to-end (`traffic.cutover_started/completed`
  events; `traffic.cutover_failed` reverts to the previous version).
- The previous active deployment drains (bounded wait for in-flight requests)
  and is retired; its history is preserved.
- Rollback uses the same cutover: the stable URL never changes.
- `stop`/`delete` of the ACTIVE deployment returns **409** unless forced with
  `?force=true` (query) or `{"force": true}` (body). Forcing takes the app
  offline (503) until the next deployment becomes active.

### CLI

```
minicloud apps        # NAME / STATUS / ACTIVE / URL columns
minicloud routes      # gateway routing table with request counters
minicloud stop <id> --force     # required when <id> is the active deployment
minicloud delete <id> --force
```


## Multi-service applications (v0.5)

Repositories may ship a `minicloud.yml` (version 1). See the README for the
full schema. Multi-service deployments expose:

```
GET /api/deployments/:id/services
200 { "services": [ { "service": "web", "status": "RUNNING", "public": true,
      "hostPort": 33421, "containerPort": 3000, "restartCount": 0, ... } ] }
409 single-service deployment
```

Deployment serialization gains `multiService: boolean` and `services: [...]`.

Per-service logs and metrics:

```
GET /api/deployments/:id/logs?service=api
GET /api/deployments/:id/metrics?service=worker
```

Volumes:

```
GET  /api/apps/:id/volumes     # list (name, dockerVolume, createdAt)
DELETE /api/apps/:id/volumes?confirm=true   # DESTRUCTIVE, explicit only
```

App deletion (`DELETE /api/apps/:id`) preserves volumes unless
`?volumes=true` is passed.

### CLI

```
minicloud services <app>
minicloud volumes <app>
minicloud logs <deployment> --service api
minicloud stats <deployment> --service worker
```
