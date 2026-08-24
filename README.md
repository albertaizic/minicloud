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
- **Environment variables & secrets** per application: plain vars are readable,
  secrets are AES-256-GCM-encrypted at rest and write-only (never returned by
  API, CLI or dashboard)
- **CPU & memory limits** enforced with Docker cgroups (`--cpus`, hard memory cap)
- **Deployment configuration snapshots**: each deployment records the effective
  non-secret config it was started with
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

minicloud deploy <git-url> [--name my-app] [--ref main]
minicloud apps
minicloud deployments [app-name]
minicloud status <deployment-id>
minicloud logs <deployment-id>       # live stream
minicloud stop <deployment-id>
minicloud restart <deployment-id>
minicloud delete <deployment-id>
minicloud wait <deployment-id>

# configuration (v0.2)
minicloud env <app>                          # list vars + secret keys
minicloud env set <app> KEY=VALUE
minicloud env delete <app> KEY
minicloud secret set <app> KEY               # value read hidden from stdin/TTY
echo "$VALUE" | minicloud secret set <app> KEY   # piped input also works
minicloud secret delete <app> KEY
minicloud limits show <app>
minicloud limits set <app> --memory 512 --cpu 1.5
minicloud limits clear <app>
```

## API overview

| Method | Path                     | Description                          |
|--------|--------------------------|--------------------------------------|
| GET    | `/api/health`            | API + Docker health                  |
| POST   | `/api/apps`              | Create application                   |
| GET    | `/api/apps`              | List applications (+ latest deploy)  |
| GET    | `/api/apps/:id`          | Application detail + deployments     |
| DELETE | `/api/apps/:id`          | Delete app and its deployments       |
| GET    | `/api/apps/:id/env`      | List env vars (values) + secret keys |
| PUT    | `/api/apps/:id/env/:key`       | Set env var (`{"value": "..."}`) |
| DELETE | `/api/apps/:id/env/:key`       | Delete env var or secret        |
| PUT    | `/api/apps/:id/secrets/:key`   | Store/replace secret (write-only, 201) |
| DELETE | `/api/apps/:id/secrets/:key`   | Delete secret                   |
| GET    | `/api/apps/:id/limits`   | Show CPU/memory limits               |
| PUT    | `/api/apps/:id/limits`   | Set limits (`memoryLimitMb`, `cpuLimit`) |
| DELETE | `/api/apps/:id/limits`   | Clear limits                         |
| POST   | `/api/apps/:id/deploy`   | Queue a deployment (202)             |
| GET    | `/api/deployments`       | List deployments                     |
| GET    | `/api/deployments/:id`   | Deployment detail                    |
| POST   | `/api/deployments/:id/stop`    | Stop deployment                |
| POST   | `/api/deployments/:id/restart` | Restart from existing image    |
| DELETE | `/api/deployments/:id`   | Remove deployment + resources        |
| GET    | `/api/deployments/:id/logs`    | Recent logs, or SSE stream with `Accept: text/event-stream` |

Validation errors return `400` with per-field details; impossible operations
return `409`; unknown ids return `404`.
Full request/response semantics for configuration endpoints: [docs/api.md](docs/api.md).


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

- **Unit tests** (state machine, URL validation, port allocation, git URL rules,
  secret encryption, config schema validation): no services required.
- **API tests** (`api.test.ts`, `config.test.ts`): require PostgreSQL from
  `docker compose`; cover env/secret/limits CRUD, redaction, and validation.
- **Integration tests** (`pipeline.integration.test.ts`,
  `config.integration.test.ts`): require Docker + PostgreSQL; exercise the real
  clone/build/start/health-check pipeline plus env injection, real cgroup
  limits (including an OOM-kill case) and redeploy/restart config behavior.

## Current limitations (v0.2)

- Public repositories only; no credentials, private repos, or monorepo path filters.
- A root-level `Dockerfile` is required — no buildpack auto-detection yet.
- Single-host, single-API-instance; the lock map is in-process (DB status guards prevent corruption, but two API instances could both attempt the same build).
- Logs are streamed/tailed live; there is no long-term log storage or search. An app that prints its own secrets will stream them like any other output — MiniCloud does not redact container stdout.
- No authentication or multi-user support.
- No automatic restart policy or rollback (restart uses the same commit's image).
- Health checks accept any HTTP response as "healthy" (even 500).
- Secrets live in one Postgres column encrypted with one master key: rotating
  `MINICLOUD_MASTER_KEY` requires re-entering secrets; losing it makes stored
  secrets undecryptable (deployments using them then fail at the config stage).

## Roadmap

1. Bounded automatic restart with backoff
2. Build log streaming polish + deployment event timeline
3. Rollback to a previous successful deployment
4. Multi-repo subdirectory builds & buildpacks
5. Secret key rotation support (`MINICLOUD_MASTER_KEY_{NEW,OLD}` re-encryption)

## Security model

MiniCloud treats repositories and their builds as **untrusted input**, but it is
a single-user local development tool — not a hardened multi-tenant sandbox.
See [docs/security.md](docs/security.md) for details on secret handling,
threat model, and operator responsibilities.

What v0.2 does:

- Git URLs are strictly validated (https/ssh forms plus localhost http); shell
  metacharacters are rejected and git runs via argument-array `execFile`.
- Deployed containers are never privileged, get no host mounts, no Docker
  socket, and no restart policy.
- Identifiers are UUID-validated before touching the filesystem; workspace paths
  are constructed internally (no traversal from user input).
- API payloads are schema-validated; status codes are precise.
- Secrets are encrypted at rest (AES-256-GCM under an scrypt-stretched master
  key), never returned by any read endpoint, and injected only into the
  container environment at start.
- Env keys are restricted to `[A-Za-z_][A-Za-z0-9_]*` so user configuration can
  never smuggle shell metacharacters or newlines into container environments.
- Optional per-app CPU/memory limits give operators a lever against runaway
  containers.

What v0.2 does **not** do:

- Built images execute arbitrary code from the repository during build *and* runtime — by design, but that means full host-level isolation must come from Docker itself, not MiniCloud.
- The API has no authentication: anyone who can reach port 4000 can deploy anything Docker can do (and read plain env vars).


## Release

Current release: **v0.1.0**; the working tree carries unreleased v0.2 work — see [CHANGELOG.md](CHANGELOG.md).


## License

MIT — see [LICENSE](LICENSE).
