# MiniCloud Architecture

## Overview

MiniCloud is a single-host PaaS: a Fastify API owns a deployment engine that
turns git repositories into running Docker containers, with PostgreSQL as the
source of truth and a React dashboard for observation and control.

```mermaid
graph TB
    subgraph Client
        CLI[minicloud CLI]
        UI[Dashboard<br/>React + Vite]
    end

    subgraph API[MiniCloud API :4000]
        REST[REST /api/v1]
        SSE[SSE log stream]
        RECON[Startup reconciliation]
        MONITOR[Crash monitor]
    end

    subgraph Engine[Deployment Engine]
        PIPE[Pipeline:<br/>clone - build - start - health check]
        PORTS[Port allocator]
        HEALTH[Health checker]
    end

    subgraph Runtime[Docker]
        BUILD[docker build]
        CONTAINERS[Managed containers<br/>labels: minicloud.*]
    end

    DB[(PostgreSQL<br/>apps + deployments + app_env)]

    CLI --> REST
    UI --> REST
    UI --> SSE
    REST --> Engine
    Engine --> BUILD
    Engine --> CONTAINERS
    PIPE --> PORTS
    PIPE --> HEALTH
    RECON --> Runtime
    MONITOR --> Runtime
    REST --> DB
    Engine --> DB
```

## Components

### apps/api (Fastify)
- Versioned REST API under `/api`.
- Server-Sent Events for live log fan-out (`GET /api/deployments/:id/logs` with `Accept: text/event-stream`).
- Startup reconciliation against Docker state.
- Central error handler; validation errors return per-field details.

### packages/deployment-engine
The core pipeline:

```text
QUEUED → CLONING → BUILDING → STARTING → HEALTH_CHECKING → RUNNING
   ↘ any stage failure → FAILED          user stop → STOPPED
```

1. **Clone** — `git clone` via `execFile` (argument array, never a shell string) into a temp dir inside the workspace. Shallow clone first, automatic fallback for servers that don't support it.
2. **Build** — requires a root-level `Dockerfile`. Image tag: `minicloud/app-<id8>:d-<depId12>`. Build output is streamed to log listeners.
3. **Port allocation** — random candidates from a configurable range, each probed with a bind test immediately before use. Docker's own bind is the final arbiter; collisions surface as clear start errors.
4. **Start** — container created with labels `minicloud.managed`, `minicloud.app`, `minicloud.deployment`. Never privileged, no host mounts, no restart policy (crash handling is explicit).
   Before creating the container the engine resolves the application's effective
   runtime configuration through a callback registered by the API layer (which
   owns the master key): plain env vars, decrypted secret values, and resource
   limits. Secret values exist only inside this call path — they are never
   logged and never persisted. The deployment's non-secret snapshot (plain
   values, secret *key names*, limits) is written to `deployments.config_snapshot`.
   Limits become cgroup controls on the container: `Memory` bytes with
   `MemorySwap = Memory` (hard cap, no swap) and `NanoCpus` (`--cpus`).
6. **RUNNING** — persisted with `started_at`.

Concurrency: one in-flight operation per deployment via an in-process lock map;
the SQL status guard (`UPDATE ... WHERE status = ANY(...)`) makes impossible
transitions unrepresentable even across processes.

### Crash detection
A monitor polls RUNNING deployments every few seconds. If the container exits or
disappears, the deployment becomes FAILED with the captured exit code and a
reason. There are no automatic restart loops in v0.1; `restart` is explicit.

### Startup reconciliation
On API boot:
1. List all containers labeled `minicloud.managed=true`.
2. Non-terminal DB rows whose container exited/missing → FAILED (+ exit code).
3. Healthy containers in pre-RUNNING states (API died mid-health-check) → RUNNING.
4. Terminal-state rows with leftover containers → containers removed.
5. Managed containers with no DB row (orphans) → removed.

The database is never blindly trusted: RUNNING requires a live container.

### Logs
Container stdout/stderr follows dockerode demuxing into SSE subscribers plus a
bounded recent-logs endpoint (`tail`). Build output flows through the same
fan-out with `source=build`. Nothing unbounded is held in memory (ring buffer of
last 500 lines client-side).

### Persistence

Three tables (`applications`, `deployments`, `app_env`) with a CHECK-constrained
status enum, migrated by `packages/db`'s runner. Ephemeral runtime objects
(containers, images) are always reconcilable from Docker; durable history lives
only in PostgreSQL.

### Application configuration (v0.2)

Per-application config lives in two places:

- `app_env` table: one row per key per app. Plain variables store their value;
  secrets store only AES-256-GCM ciphertext under an scrypt-stretched
  operator master key. A CHECK constraint makes the two value shapes mutually
  exclusive.
- `applications.memory_limit_mb` / `cpu_limit`: current limits.

Resolution flow at container start:

```mermaid
sequenceDiagram
    participant E as Deployment Engine
    participant A as API (owns master key)
    participant DB as PostgreSQL
    participant D as Docker
    E->>A: resolveAppConfig(appId)
    A->>DB: read app_env rows + limits
    A-->>E: { env (plain + decrypted secrets), secretKeys, limits }
    E->>DB: persist non-secret snapshot
    E->>D: create container (env, Memory/MemorySwap/NanoCpus)
```

Failures in this stage fail the deployment cleanly (`config` stage reason), for
example when secrets exist but `MINICLOUD_MASTER_KEY` is not configured.
Restart re-runs resolution so containers pick up changed configuration without
a rebuild; the snapshot is refreshed to stay truthful about the running
container. Historical deployments keep their original snapshot.
