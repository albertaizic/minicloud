# Security notes

Scope: MiniCloud v0.2 configuration features — environment variables, secrets,
and resource limits. Read together with the security model in the
[README](../README.md#security-model).

## Threat model assumptions

MiniCloud is a **single-user, local development PaaS**. We assume:

- The operator's machine and Docker daemon are trusted.
- Anyone with network access to the API port is a full administrator (there is
  no authentication yet). Run it bound to `127.0.0.1` if that matters to you.
- Deployed applications are untrusted code: they can read their *own*
  environment (including secret values injected into them) by design.

## Secrets

### At rest

- Secret values are encrypted with **AES-256-GCM**; the AES key is derived from
  `MINICLOUD_MASTER_KEY` via **scrypt** (`N=2^15` default parameters of Node's
  implementation, salted with the fixed string `minicloud-secret-encryption`).
- Ciphertext format: `v1:<base64(iv)>:<base64(ciphertext||tag)>`. Each write
  uses a fresh 96-bit random IV, so encrypting the same value twice yields
  different ciphertexts.
- GCM authentication means tampered rows or wrong-key decryption **fail
  loudly** (`MasterKeyError`) instead of returning attacker-controlled or
  garbage plaintext into a container environment.
- Only the encrypted value is stored in PostgreSQL (`app_env.encrypted_value`);
  plain variables live in `plain_value` and are mutually exclusive per row
  (enforced by a CHECK constraint).

### In transit / at rest elsewhere

- Values are accepted only over the write endpoints and exist in memory just
  long enough to be encrypted (API) or injected (engine).
- No endpoint ever returns a secret value: list endpoints return keys and
  timestamps only; set endpoints return the key name; deployment snapshots
  record **key names** (`secretKeys[]`), never values.
- Logs (API request logs, engine pipeline logs, SSE streams emitted by
  MiniCloud itself) contain counts and key names only.

### Injection

- At container start the engine asks the API layer for the effective runtime
  environment. Plain values come from storage as-is; secrets are decrypted at
  this point. The map goes directly into the Docker create-container call —
  it is never logged, never persisted, and never sent anywhere else.
- Keys are validated against `[A-Za-z_][A-Za-z0-9_]*`, so user input cannot
  introduce `=`, newlines, NULs, or shell metacharacters into the environment
  block. Values may be arbitrary UTF-8 up to 8 KiB (Docker handles transport;
  there is no shell involved anywhere in MiniCloud's container start path).
- A secret whose decryption fails aborts the deployment/start with a clear
  error rather than starting a half-configured container.

### Key management responsibilities (operator)

- Provide `MINICLOUD_MASTER_KEY` (≥ 16 chars; generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
- If the variable is absent, secrets are disabled: secret endpoints return
  `503`, and deployments of apps that have secrets fail cleanly at the config
  stage. Plain env vars and limits keep working.
- If the variable is present but invalid, API startup fails fast — we prefer a
  crash over silently degraded secret handling.
- **Rotation is manual**: re-enter every secret after changing the key.
- **Loss is unrecoverable**: encrypted values cannot be decrypted without the
  key; affected deployments fail with `config: ...MINICLOUD_MASTER_KEY...`.

## Known limitations (be honest about them)

- The database file/backups of an unencrypted Postgres instance hold
  ciphertext, but *plain* env var values are intentionally readable — do not
  put secrets in plain vars.
- Container stdout/stderr is streamed verbatim. An application that prints its
  own secrets will leak them into log viewers; MiniCloud does not redact app
  output.
- Process-level introspection on the API host (memory dump, `/proc`) can see
  plaintext during decrypt/inject windows. This is inherent to local PaaS.
- No re-encryption/rotation tooling yet (roadmap item).

## Resource limits

- Limits translate to cgroup controls: `Memory` bytes (with
  `MemorySwap = Memory` so swap cannot double the cap) and `NanoCpus`
  (`--cpus`). Validation bounds: memory 16–65536 MB (integer), CPU 0.1–64.
- Limits are applied at container create time; changing limits affects new
  deployments and restarts of existing deployments.
- Verified against real containers in `config.integration.test.ts`, including
  a functional OOM case (exit code 137).


## Events, metrics and rollback (v0.3)

- **Events never carry secret values.** Event metadata is structural only
  (attempt counters, image tags, exit codes, ports). The engine's event helper
  documents this rule at the only choke point where events are written.
- Event history is scoped per deployment and cascades away with it; the events
  endpoint requires a valid deployment id and exposes nothing cross-app.
- **Metrics** are read live from Docker stats per request; nothing is stored,
  so there is no historical metric data to leak. Memory figures come from the
  container's own cgroup — an app can observe the same numbers.
- **Rollback** never mutates historical deployments: it creates a new row that
  references the target. Rollback targets must belong to the same application
  and have a built image; the API maps rule violations to 404/409 instead of
  leaking engine internals.
- **Prune** operates exclusively on MiniCloud-labelled containers,
  `minicloud/app-*` images and `clone-*` workspace directories. It cannot touch
  unrelated Docker resources, and images referenced by any deployment are
  preserved as rollback targets.
- `MINICLOUD_RESTART_ATTEMPT` (injected into automatic-restart containers) is a
  counter, not secret material.

## Input validation summary

| Input | Rule |
|---|---|
| Env/secret key | `[A-Za-z_][A-Za-z0-9_]*`, 1–128 chars |
| Env/secret value | ≤ 8192 chars |
| `memoryLimitMb` | integer 16–65536 |
| `cpuLimit` | number 0.1–64 |
| Restart policy | `disabled` or `on-failure`; attempts integer 0–10 |
| Cross-kind overwrite | rejected `409` (delete first) |
| Unknown payload fields | rejected (`strict()` schemas) |
| IDs in URLs | UUID-validated before DB access |
