# Changelog

All notable changes to MiniCloud are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org).

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
