# Changelog

All notable changes to MiniCloud are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org).

## [Unreleased] — v0.7 deployment execution layer: queue, cancellation, build cache, PR previews

### Added

- **Persistent deployment queue**: every deploy/rollback/auto-deploy/preview creates a durable `deployment_jobs` row (migration 007). Queue state survives API restarts; ordering is deterministic `(priority, created_at)`; per-application serialization means stale revisions of one app can never race into traffic
- **Configurable concurrency**: `MINICLOUD_MAX_CONCURRENT_BUILDS` bounds simultaneous builds/deployments; queued jobs wait visibly; freeing a slot starts the next eligible job immediately
- **Priority policy**: manual deploys (10) → rollbacks (15) → git auto-deploys (50) → previews (90); lower runs first. Persisted so restart behavior stays deterministic
- **Superseding**: a newly enqueued git/preview job supersedes still-queued jobs of the same trigger for the same application (`SUPERSEDED`, with `superseded_by` + events). Manual jobs are never auto-superseded; running deployments finish but cannot steal traffic from newer revisions (guarded cutover)
- **Cancellation**: `POST /api/deployments/:id/cancel`, `minicloud cancel`, dashboard button. QUEUED cancels instantly; CLONING/BUILDING unwinds the child git/docker work and cleans candidate containers; STARTING/HEALTH_CHECKING stops the candidate set; RUNNING is refused with stop/rollback guidance. Cancellation never touches volumes or the active revision
- **Build cache**: exact-image reuse keyed by `sha256(commit + Dockerfile + context content manifest)` per app/service (`build_artifacts`). Unchanged rebuilds skip clone/build entirely (`build.image_reused`); real builds record `build.cache_miss`; Docker layer caching still accelerates misses. Prune keeps artifact images as rollback targets
- **Restart recovery**: startup reconcile → queue recovery finalizes orphaned claims from reconciled deployment truth (requeue never-started work, finalize interrupted work), then the scheduler resumes. No duplicate cutovers, no zombie claims
- **GitHub pull-request preview environments** (migrations 008): `pull_request opened/reopened/synchronize` deploy an isolated preview at `http://pr-<n>-<slug>.localhost:<gateway-port>`; `synchronize` replaces it zero-downtime at the same URL; `closed` removes route + containers + network. One logical preview per (app, PR)
- **Preview isolation**: previews run in their own Docker network (`minicloud-prev-*`) with EPHEMERAL storage — production volumes are never mounted; production routing state is never consulted or modified
- **Preview secret policy**: plain env vars flow into previews; encrypted secrets do NOT unless an explicit opt-in is enabled on the application. PR code is untrusted by default
- **Webhook hardening**: delivery-id deduplication (`webhook_deliveries`) makes GitHub retries idempotent; signature verification precedes any payload trust; base-branch scoping; preview route keys derive only from the MiniCloud application slug + PR number
- **Queue & preview observability**: `GET /api/queue` + `/api/apps/:id/queue` (deterministic positions), queue panel on overview/app pages with source chips (manual/git push/PR preview) and cancel actions, preview panel with PREVIEW badges distinct from PRODUCTION, build cache status on deployment detail, `queue.claimed/superseded`, `build.cache_hit/miss/image_reused`, `preview.*` events
- **CLI**: `minicloud cancel`, `minicloud queue [app]`, `minicloud previews <app>`, `minicloud preview-delete <app> <PR#>`

### Fixed

- Git auto-deploy now records `last_deployed_sha` when a job completes, preventing repeated redeploys of an already-built SHA
- E2E suite: database reset uses `DROP DATABASE … WITH (FORCE)` and wired global setup/teardown; app fixtures are find-or-create; ambiguous/duplicated-name selectors replaced with deterministic ones; limits form no longer swallows invalid input behind native browser validation

### Security

- Preview environments default to NO production secrets and NO production volumes
- Preview cleanup is scoped by preview environment identity — closing a PR cannot touch production resources
- Webhook replay protection via delivery GUID dedup; HMAC validation unchanged and always first



## [Unreleased] — v0.5 multi-service, private networking, volumes

### Added

- **`minicloud.yml` manifest (version 1)**: multiple services per application with dockerfile/context, ports, public/private visibility, health paths, per-service env/resources/restart policy, `depends_on` (cycle-validated, topological start order) and named volumes. Strict schema — host mounts, privileged mode and arbitrary networks are unrepresentable
- **Private application networking**: per-application Docker network (`minicloud-app-*`), service-name DNS aliases, `NAME_SERVICE_HOST/PORT` env injection; applications never share networks
- **Public/private routing**: only `public: true` services get gateway routes (`<app>.localhost` for the primary, `<service>.<app>.localhost` for the rest); private services are unreachable via the gateway
- **Persistent volumes**: MiniCloud-managed named volumes (`minicloud-<app8>-<name>`), surviving deployments, rollbacks and restarts; explicit destructive deletion only; never pruned
- **Per-service observability**: service rows in deployment responses, `GET /api/deployments/:id/services`, per-service logs/metrics (`?service=`), `minicloud services/volumes`, service-scoped events (`service.*`, `network.created`, `volume.attached`)
- **Per-service restart policies**: crash monitor handles service containers individually with per-service budgets; worker crashes never touch sibling services
- **Multi-service rollback**: restores the entire previous revision (services, images, routing) while volumes persist
- Example: `examples/multi-service-app` (web + api + worker + volume)

## [Unreleased] — v0.4 routing & zero-downtime deployments

### Added

- **MiniCloud gateway**: in-process reverse proxy giving every application a stable URL `http://<app>.localhost:<gateway-port>` (default 8080); hostname-based routing, streaming bodies, WebSocket upgrades, forwarding headers set from the real connection, hop-by-hop header stripping, bounded per-route request counters
- **Active deployment model**: `applications.active_deployment_id` + `route_slug` (migration 004, backfilled); exactly one active deployment per app, validated during startup reconciliation
- **Zero-downtime cutover**: replacements build/health-check while the old version serves; traffic switches atomically only after gateway verification; failed cutovers revert; superseded deployments retire themselves instead of stealing traffic
- **Drain & retire**: bounded wait for in-flight requests, then old containers are stopped (records, logs, events, images preserved)
- **Rollback integration**: same stable URL before and after; traffic events cover requested → ready → switched → retired
- **Crash-recovery routing**: active-deployment crashes produce honest 503s, recovery re-points the gateway automatically; non-active deployments never affect routing
- **Explicit outage semantics**: stop/delete of the ACTIVE deployment returns 409 unless forced (`?force=true` / `{"force": true}`)
- **Observability**: `GET /api/routes`, `minicloud routes`, stable URL + active deployment in `minicloud apps` and the dashboard (ACTIVE badges, stable URL banners, force-stop confirmation)
- Startup reconciliation rebuilds the routing table from persisted state and retires stale non-active RUNNING deployments

### Changed

- Deployments no longer need their random host port for normal traffic; it remains visible as diagnostic information

## [Unreleased] — v0.3 reliability & observability

### Added

- **Deployment event timeline**: every lifecycle transition is persisted to a new `deployment_events` table with monotonic ordering, exposed via `GET /api/deployments/:id/events`, `minicloud events` and a dashboard timeline
- **Rollback**: `POST /api/apps/:id/rollback`, `minicloud rollback <app> <deployment>` and dashboard rollback buttons with confirmation. Creates a NEW deployment linked via `rollback_of_deployment_id`; reuses the target's image when available, rebuilds from the recorded commit otherwise; historical deployments and snapshots are never mutated
- **Automatic restart policy**: per-application `disabled`/`on-failure` with a 0–10 attempt budget (`PUT /api/apps/:id/restart-policy`, `minicloud restart-policy`). Timer-free backoff (`min(2^N×2s, 15s)`) stored in the database so recovery survives API restarts; manual stop cancels pending recovery, manual restart/deploy resets the budget; exhaustion is terminal
- **Runtime metrics**: `GET /api/deployments/:id/metrics` and `minicloud stats` — live CPU %, memory used/limit/%, uptime and restart counts from one-shot Docker stats (docker-CLI-compatible formulas); 409 with explanation instead of fake zeros when unavailable
- **Prune**: `minicloud prune` / `POST /api/prune` removes only MiniCloud-owned stopped containers, images no deployment references (rollback targets are kept), and `clone-*` workspace dirs older than an hour
- Startup reconciliation now routes offline crashes through the same policy-aware recovery path as live monitoring
- Fixtures: `examples/rev-app-{a,b}` (two observable revisions) and `examples/crash-once` (crashes after passing health unless auto-restarted)

### Changed

- Crash detection moved from the API layer into the engine (`engine.checkCrashes()`); crashed containers are now removed after their exit code is recorded
- Deployment serialization includes `autoRestartCount` and `rollbackOf`; application serialization includes `restartPolicy`/`maxRestartAttempts`

### Security

- Event metadata is restricted to structural context (counters, tags, exit codes, ports) — never secret values; enforced at the single event-writing choke point

## [Unreleased] — v0.2 configuration

### Added

- Per-application environment variables: create, list, update, delete via API, CLI and dashboard; injected into every new deployment and restart automatically
- Per-application secrets, encrypted at rest with AES-256-GCM under an operator-supplied master key (`MINICLOUD_MASTER_KEY`, scrypt-stretched). Secret values are write-only: never returned by the API, CLI or dashboard; deployment snapshots record secret key names only
- Container resource limits per application (`memoryLimitMb` 16–65536, `cpuLimit` 0.1–64) mapped to Docker `Memory`/`NanoCpus` with a hard cap (`MemorySwap = Memory`, no swap slack)
- Deployment configuration snapshots: every deployment persists the effective non-secret config (plain var values, secret key names, limits) it was started with; restarts refresh it to current config while historical deployments keep their original snapshot
- New fixtures for integration testing: `examples/env-echo` (echoes configured env) and `examples/memory-hog` (deliberate OOM under a small cgroup limit)
- Documentation: security notes (`docs/security.md`) and full API/CLI reference (`docs/api.md`)

### Changed

- Restarts now apply the application's *current* configuration (env, secrets, limits) instead of the values captured at deploy time; the snapshot is refreshed accordingly
- Config-resolution failures (e.g. missing master key while secrets exist) fail the deployment cleanly at the `config` stage instead of leaving it stuck mid-pipeline

### Security

- Env/secret keys are restricted to `[A-Za-z_][A-Za-z0-9_]*`; cross-kind overwrites (secret → plain variable or vice versa) are rejected with `409`
- Secrets endpoints return `503` with operator guidance when no master key is configured; an invalid-but-present key fails API startup loudly

## [0.1.0] - 2026-08-24

### Added

- Git-to-container deployment pipeline: clone → docker build → start → health check → RUNNING
- Explicit deployment state machine (QUEUED / CLONING / BUILDING / STARTING / HEALTH_CHECKING / RUNNING / FAILED / STOPPED) with SQL-guarded transitions
- Automatic host port allocation in a configurable range
- HTTP health checks with configurable path, port, and bounded timeout
- Live log streaming over Server-Sent Events (build output + container stdout/stderr)
- Crash detection: background monitor marks crashed deployments FAILED with the captured exit code
- Stop / restart / delete / redeploy operations, concurrency-guarded per deployment
- Startup reconciliation between PostgreSQL and Docker state, including orphaned-container cleanup
- REST API (`/api`) with schema-validated payloads and precise status codes
- `minicloud` CLI: deploy, apps, deployments, status, logs, stop, restart, delete, wait; accepts unambiguous short id prefixes
- Web dashboard (React + Vite): overview, application detail, deployment detail with live log viewer
- PostgreSQL persistence with a migration runner
- Example fixtures: `examples/hello-node` (healthy) and `examples/failing-app` (intentional crash)
- Test suite: unit, API, and Docker pipeline integration tests
- GitHub Actions CI: typecheck, tests, production build, integration tests

[0.1.0]: https://github.com/albertaizic/minicloud/releases/tag/v0.1.0
