# API & CLI reference (v0.2)

Base URL: `http://localhost:4000` (`PORT` / `HOST` in `.env`).
All bodies are JSON; validation failures return `400` with
`{"error": "...", "details": {field: [messages]}}`.

This page documents the v0.2 configuration endpoints and CLI commands. For the
core deployment endpoints see the [README](../README.md#api-overview).

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

## Dashboard

The application page has a **Configuration** section:

- Environment variables table with add/update/delete.
- Secrets table showing masked values (`••••••••`) with replace/delete; typed
  values use a password input and are never rendered back.
- Resource limit form (memory MB / CPUs) with save and clear.

Deployment pages show the recorded snapshot: plain values, masked secret rows,
and the effective limits.
