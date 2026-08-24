# MiniCloud

<div align="center">

**Deploy any git repo to Docker with one command.**
A lightweight, self-hosted Platform-as-a-Service for your own machine —
the Render/Heroku/Railway/Fly.io developer experience, running locally.

[![CI](https://github.com/albertaizic/minicloud/actions/workflows/ci.yml/badge.svg)](https://github.com/albertaizic/minicloud/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.1.0-58a6ff)](../../releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-3fb950?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-8b949e)](LICENSE)

</div>

---

MiniCloud turns a repository into a running, health-checked container:

```bash
minicloud deploy https://github.com/example/my-api
# ✔ deployment is RUNNING at http://localhost:31542
```

It clones your repo, builds the Dockerfile, starts an isolated container on a
free port, health-checks it, streams its logs live, detects crashes, and tracks
every deployment in PostgreSQL — with a CLI and a web dashboard on top.

| Overview | Deployment detail |
|---|---|
| ![MiniCloud dashboard overview](screenshots/overview.png) | ![MiniCloud deployment view](screenshots/deployment_view.png) |

**Why this project exists.** MiniCloud is a deliberate, end-to-end exercise in
platform engineering: a real deployment pipeline with a strict state machine,
startup reconciliation between a database and Docker, crash detection, live log
streaming, and a tested public API — the same problems cloud PaaS products
solve, at an understandable scale.

## Features

- **Git-to-container pipeline**: clone → docker build → start → health check → RUNNING
- **Explicit deployment state machine** (QUEUED → CLONING → BUILDING → STARTING → HEALTH_CHECKING → RUNNING / FAILED / STOPPED)
- **Automatic host port allocation** in a configurable range
- **HTTP health checks** with bounded retries and configurable path/port/timeout
- **Live logs** over Server-Sent Events (build output + container stdout/stderr)
- **Crash detection**: a monitor marks crashed deployments FAILED with the exit code
- **Stop / restart / delete / redeploy**, all idempotent and concurrency-guarded
- **Startup reconciliation**: DB and Docker are re-synced on every API boot; orphaned containers are cleaned up
- **REST API + CLI + web dashboard**
- **PostgreSQL persistence** with migrations

## Architecture

```mermaid
graph LR
    CLI[minicloud CLI] --> API[Fastify API]
    UI[Dashboard] --> API
    API --> ENG[Deployment Engine]
    ENG --> D[(PostgreSQL)]
    ENG --> DK[Docker: build/run/health-check]
```

See [docs/architecture.md](docs/architecture.md) for the full architecture,
deployment lifecycle, and reconciliation strategy.

## Prerequisites

- Node.js ≥ 20
- Docker Desktop (or any Docker daemon)
- Docker Compose v2
- Git

## Setup

```bash
git clone <this-repo> minicloud
cd minicloud
npm install
cp .env.example .env        # adjust if needed (see POSTGRES_HOST_PORT note below)
docker compose up -d postgres
npm run migrate
```

> **Note:** if a local PostgreSQL already listens on port 5432 (common on
> Windows), set `POSTGRES_HOST_PORT=5433` in `.env` (the default) so the
> MiniCloud database does not collide with it.

## Quick start

Terminal 1 — API:

```bash
npm run dev            # http://localhost:4000
```

Terminal 2 — dashboard:

```bash
npm run dev:dashboard  # http://localhost:5173
```

Deploy your first app:

```bash
minicloud deploy https://github.com/example/hello-node --name hello-node
minicloud apps
minicloud logs <deployment-id>
```

Or deploy one of the bundled examples. From the repo root:

```bash
cd examples/hello-node
npx serve .            # or push to any git remote and use that URL
```

## CLI

The CLI talks to the MiniCloud API (`MINICLOUD_API_URL`, default
`http://localhost:4000`):

```bash
minicloud deploy <git-url> [--name my-app] [--ref main]
minicloud apps
minicloud deployments [app-name]
minicloud status <deployment-id>
minicloud logs <deployment-id>       # live stream
minicloud stop <deployment-id>
minicloud restart <deployment-id>
minicloud delete <deployment-id>
minicloud wait <deployment-id>
```

During development, invoke it via `npx tsx apps/cli/src/minicloud.ts` or link
the workspace.

## API overview

| Method | Path                     | Description                          |
|--------|--------------------------|--------------------------------------|
| GET    | `/api/health`            | API + Docker health                  |
| POST   | `/api/apps`              | Create application                   |
| GET    | `/api/apps`              | List applications (+ latest deploy)  |
| GET    | `/api/apps/:id`          | Application detail + deployments     |
| DELETE | `/api/apps/:id`          | Delete app and its deployments       |
| POST   | `/api/apps/:id/deploy`   | Queue a deployment (202)             |
| GET    | `/api/deployments`       | List deployments                     |
| GET    | `/api/deployments/:id`   | Deployment detail                    |
| POST   | `/api/deployments/:id/stop`    | Stop deployment                |
| POST   | `/api/deployments/:id/restart` | Restart from existing image    |
| DELETE | `/api/deployments/:id`   | Remove deployment + resources        |
| GET    | `/api/deployments/:id/logs`    | Recent logs, or SSE stream with `Accept: text/event-stream` |

Validation errors return `400` with per-field details; impossible operations
return `409`; unknown ids return `404`.

## Development

```bash
npm run dev            # API with watch mode
npm run dev:dashboard  # Vite dev server
npm run typecheck      # tsc across all workspaces
npm test               # unit + API tests (API tests need Postgres)
npm run test:integration -w @minicloud/api   # Docker pipeline tests
npm run build          # production builds
```

### Testing

- **Unit tests** (state machine, URL validation, port allocation, git URL rules): no services required.
- **API tests** (`apps/api/src/api.test.ts`): require PostgreSQL from `docker compose`.
- **Integration tests** (`apps/api/src/pipeline.integration.test.ts`): require Docker + PostgreSQL; exercise the real clone/build/start/health-check/stop/restart/crash pipeline against `examples/`.

## Current limitations (v0.1)

- Public repositories only; no credentials, private repos, or monorepo path filters.
- A root-level `Dockerfile` is required — no buildpack auto-detection yet.
- Single-host, single-API-instance; the lock map is in-process (DB status guards prevent corruption, but two API instances could both attempt the same build).
- Logs are streamed/tailed live; there is no long-term log storage or search.
- No authentication or multi-user support.
- No automatic restart policy or rollback (restart uses the same commit's image).
- Health checks accept any HTTP response as "healthy" (even 500).

## Roadmap

1. Environment variables & secrets per app
2. Bounded automatic restart with backoff
3. Build log streaming polish + deployment event timeline
4. Rollback to a previous successful deployment
5. Resource limits (CPU/memory) via Docker stats
6. Multi-repo subdirectory builds & buildpacks

## Security model

MiniCloud treats repositories and their builds as **untrusted input**, but it is
a single-user local development tool — not a hardened multi-tenant sandbox.

What v0.1 does:

- Git URLs are strictly validated (https/ssh forms plus localhost http); shell
  metacharacters are rejected and git runs via argument-array `execFile`.
- Deployed containers are never privileged, get no host mounts, no Docker
  socket, and no restart policy.
- Identifiers are UUID-validated before touching the filesystem; workspace paths
  are constructed internally (no traversal from user input).
- API payloads are schema-validated; status codes are precise.

What v0.1 does **not** do:

- Containers can consume unbounded CPU/RAM/disk; no cgroups limits yet.
- Built images execute arbitrary code from the repository during build *and* runtime — by design, but that means full host-level isolation must come from Docker itself, not MiniCloud.
- The API has no authentication: anyone who can reach port 4000 can deploy anything Docker can do.

## Release

Current release: **v0.1.0** — see [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
