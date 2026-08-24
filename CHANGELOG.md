# Changelog

All notable changes to MiniCloud are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org).


## [Unreleased]

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
