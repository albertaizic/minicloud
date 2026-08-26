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


## Gateway and traffic routing (v0.4)

- **No SSRF surface by construction**: upstream `host:port` pairs originate
  only from MiniCloud deployment rows; no request input is ever used to choose
  a destination. The gateway proxies solely to 127.0.0.1 ports of
  MiniCloud-managed containers.
- **Host validation**: requests must arrive with `Host: <slug>.localhost`
  (optionally `:port`); slugs are strictly `[a-z0-9][a-z0-9-]{0,62}`. Anything
  else — including `app.evil.com`, bare `localhost`, or oversized slugs — is
  rejected with 404 and never proxied.
- **Forwarding headers**: inbound `X-Forwarded-For/Proto/Host` are stripped and
  re-set from the actual connection, so clients cannot forge a proxy chain.
- **Hop-by-hop headers** (and headers named by `Connection:`) are stripped in
  both directions — this also removes the classic request-smuggling vectors
  that rely on conflicting framing headers. Bodies stream unbuffered.
- **Upgrades**: WebSocket upgrades are answered only when the upstream accepts
  them; both sockets are torn down together on error/close.
- **Failure honesty**: unknown host → 404; known app without active deployment
  → 503; unreachable container → 502. The gateway never reports success before
  a route is verified (`traffic.cutover_failed` reverts unverified switches).
- **Limitations**: this is a local, unauthenticated development gateway. It does
  not terminate TLS, rate-limit, or authenticate applications; anyone who can
  reach the gateway port can reach any active app. Header-based routing means
  any HTTP client on the machine can address any app by setting the Host
  header — the same trust boundary as the rest of MiniCloud.


## Multi-service manifests, networks and volumes (v0.5)

Manifests are repository content — untrusted input. The parser rejects:
path traversal in dockerfile/context, absolute paths, unknown fields
(including `privileged`, host mounts, custom networks — there is simply no
schema field for them), invalid ports/resources, duplicate service identities,
dependency cycles, self/unknown dependencies, undeclared volume mounts, and
mount targets outside absolute POSIX paths. Service names become Docker
network aliases and gateway labels only after strict validation.

- Networks and volumes are named exclusively by MiniCloud
  (`minicloud-app-<id8>`, `minicloud-<id8>-<vol>`) — user input never reaches
  Docker resource names unvalidated.
- Private services get no host port and no gateway route: they are unreachable
  from outside the application network (verified by tests). Cross-application
  traffic would require a shared network, which MiniCloud never creates.
- Volumes are Docker NAMED volumes; no host paths are ever mounted. Deletion
  is explicit (`?volumes=true` / `?confirm=true`) and never implicit —
  deploys, rollbacks, deployment deletion and prune preserve data.
- Manifest snapshots are stored as non-secret deployment configuration;
  secrets remain in the encrypted app-level store and never enter snapshots,
  events or manifests.

## Deployment queue, cancellation and build cache (v0.7)

The queue is the only path to execution, so its security properties matter:

- **Claim atomicity** — jobs are claimed with a guarded `UPDATE … WHERE id =
  (SELECT … FOR UPDATE SKIP LOCKED)`. Two schedulers (or a restart racing a
  tick) can never run one job twice; the claim token binds completion writes
  to the worker that started the job.
- **Stale claims cannot act** — after a restart, recovery derives terminal
  job state from reconciled deployment truth; it never resumes work it did
  not start. Heartbeats make foreign claims detectable.
- **Cancellation races are decided in SQL** — the CANCELLED transition is
  guarded on the current status, so exactly one side (pipeline failure or
  canceller) wins; the loser's write no-ops. The cancel endpoint refuses
  RUNNING deployments instead of masquerading as stop.
- **Cache identity is content-based** — reuse requires an exact fingerprint
  over commit SHA + Dockerfile bytes + full context manifest for the SAME
  application and service. Cross-app confusion is unrepresentable (the app id
  is part of the lookup key). Fingerprint metadata never contains secret
  values; artifact rows store tags and hashes only.
- **Prune keeps cached/rollback images** — artifact tags count as referenced,
  so cache hits can never resurrect or delete another deployment's image.

## Preview environments (v0.7)

PR code is *untrusted by default*; previews are designed around that:

- **No production secrets in previews** — preview containers resolve config
  through the same resolver but with secrets excluded unless explicitly opted
  in per application (`applications.secrets_in_previews`, default false).
  Regression-tested: container env of a preview must not contain secret keys.
- **No production volumes** — previews mount nothing; manifests' volumes are
  ignored for preview deployments, so PR code can neither read nor corrupt
  persistent data. Preview networks (`minicloud-prev-*`) are separate from
  application networks.
- **Route ownership** — preview route keys are `pr-<n>-<app-slug>`, derived
  from MiniCloud state, never payload strings. The gateway serves only
  registered routes; unknown/malformed hosts get 404/503. A preview cutover
  swaps the preview pointer under a preview-scoped lock — production traffic
  state is unreachable from preview logic.
- **Webhook hardening** — HMAC-SHA256 verification happens before any payload
  content is trusted; deliveries dedup on `X-GitHub-Delivery` (retries and
  replays become no-ops); applications match by normalized repository URL;
  base-branch scoping prevents arbitrary-branch triggers. Payload values can
  never create applications, choose ids, or name routes.
- **Scoped cleanup** — closing a preview tears down its own containers and
  network only; production resources are addressed exclusively through
  production state, which preview cleanup never touches.

### Known limitations

- Preview isolation is network + storage + secret scoped; PR builds still
  execute Docker builds on the shared daemon. A hardened multi-tenant setup
  would need gVisor/Kata-style sandboxing (out of scope for single-node v0.7).
- The build cache trusts local image integrity; images are not re-verified by
  digest after reuse.
