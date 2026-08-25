// minicloud.yml — the MiniCloud application manifest (version 1).
//
// The manifest is UNTRUSTED INPUT (it comes from a git repository). Every
// field is strictly validated; anything not in the schema is rejected. The
// deliberately constrained surface is what makes multi-service deployments
// safe: no host mounts, no arbitrary networks, no privileged mode, no
// user-chosen container names.
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILENAME = 'minicloud.yml';

export const SERVICE_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;

/** Volume mount target inside the container: absolute POSIX path, no traversal. */
const MOUNT_TARGET_RE = /^\/[A-Za-z0-9._\-/]{1,100}$/;

const serviceName = z.string().regex(SERVICE_NAME_RE, 'service name must match [a-z][a-z0-9-]* (max 31 chars)');

/** Repo-relative path that cannot escape the repository. */
const safeRepoPath = (what: string) =>
  z
    .string()
    .min(1)
    .max(200)
    .refine((p) => !path.isAbsolute(p), `${what} must be a repository-relative path`)
    .refine((p) => {
      const normalized = path.posix.normalize(p.replace(/\\/g, '/'));
      return !normalized.startsWith('..') && !normalized.includes('..');
    }, `${what} must not traverse outside the repository`);

const serviceSchema = z
  .object({
    dockerfile: safeRepoPath('dockerfile').default('Dockerfile'),
    context: safeRepoPath('context').default('.'),
    port: z.number().int().min(1).max(65535).optional(),
    public: z.boolean().default(false),
    health: z
      .object({
        path: z.string().regex(/^\/[\w\-./]{0,199}$/).default('/health'),
        timeoutSeconds: z.number().int().min(5).max(600).optional(),
      })
      .strict()
      .optional(),
    env: z.record(z.string().max(8192)).optional(),
    resources: z
      .object({
        memory_mb: z.number().int().min(16).max(65536),
        cpus: z.number().min(0.1).max(64),
      })
      .strict()
      .optional(),
    restart: z.enum(['disabled', 'on-failure']).default('disabled'),
    max_restart_attempts: z.number().int().min(0).max(10).default(3),
    depends_on: z.array(serviceName).max(10).default([]),
    volumes: z
      .array(
        z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,30}:\/[A-Za-z0-9._\-/]{1,100}$/, 'volume mount must be "<name>:</abs/path>"'),
      )
      .max(5)
      .default([]),
  })
  .strict();

const volumesSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  z.object({ driver: z.literal('local').default('local') }).strict(),
);

export const manifestSchema = z
  .object({
    version: z.literal(1),
    services: z.record(serviceName, serviceSchema).refine(
      (services) => Object.keys(services).length >= 1 && Object.keys(services).length <= 10,
      'manifest must declare between 1 and 10 services',
    ),
    volumes: volumesSchema.default({}),
  })
  .strict();

/** Normalized (camelCase) service definition used throughout the engine. */
export interface ManifestService {
  name: string;
  dockerfile: string;
  context: string;
  port?: number;
  public: boolean;
  health?: { path: string; timeoutSeconds?: number };
  env: Record<string, string>;
  resources?: { memoryLimitMb: number; cpuLimit: number };
  restart: 'disabled' | 'on-failure';
  maxRestartAttempts: number;
  dependsOn: string[];
  /** Mounts as declared: "<volume-name>:</abs/path>" */
  volumes: string[];
}
export type Manifest = {
  version: 1;
  services: ManifestService[];
  volumes: Record<string, { driver: 'local' }>;
  /** Topological service start order (dependencies first). */
  startOrder: string[];
};

export class ManifestError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, string[]>,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** Detect dependency cycles via DFS; returns the cycle path for the error. */
function findCycle(deps: Record<string, string[]>): string[] | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color: Record<string, number> = {};
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    color[n] = GRAY;
    stack.push(n);
    for (const d of deps[n] ?? []) {
      if (color[d] === GRAY) {
        const from = stack.indexOf(d);
        return [...stack.slice(from), d];
      }
      if ((color[d] ?? WHITE) === WHITE) {
        const cyc = visit(d);
        if (cyc) return cyc;
      }
    }
    stack.pop();
    color[n] = BLACK;
    return null;
  };
  for (const n of Object.keys(deps)) {
    if ((color[n] ?? WHITE) === WHITE) {
      const cyc = visit(n);
      if (cyc) return cyc;
    }
  }
  return null;
}

/** Kahn topological sort; input must already be cycle-free. */
export function topoSort(deps: Record<string, string[]>): string[] {
  const indegree: Record<string, number> = {};
  const dependents: Record<string, string[]> = {};
  for (const [n, ds] of Object.entries(deps)) {
    indegree[n] ??= 0;
    for (const d of ds) {
      indegree[n] = (indegree[n] ?? 0) + 1;
      (dependents[d] ??= []).push(n);
    }
  }
  const queue = Object.keys(indegree).filter((n) => (indegree[n] ?? 0) === 0).sort();
  const order: string[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of dependents[n] ?? []) {
      indegree[m] = (indegree[m] ?? 0) - 1;
      if (indegree[m] === 0) queue.push(m);
    }
  }
  return order;
}

export interface ParsedManifest {
  manifest: Manifest;
  /** Dockerfile paths that must exist in the repository, per service. */
  requiredFiles: Array<{ service: string; dockerfile: string; context: string }>;
}

/**
 * Parse + validate raw manifest text. Throws ManifestError with actionable
 * details on any violation. File existence is checked against the cloned
 * repository by the caller (pass repoDir to validate here).
 */
export function parseManifest(raw: string, repoDir?: string): ParsedManifest {
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    throw new ManifestError(`minicloud.yml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = manifestSchema.safeParse(data);
  if (!parsed.success) {
    const details: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.') || 'manifest';
      (details[key] ??= []).push(issue.message);
    }
    const summary = Object.entries(details)
      .map(([k, v]) => `${k}: ${v[0]}`)
      .slice(0, 3)
      .join('; ');
    throw new ManifestError(`minicloud.yml failed validation: ${summary}`, details);
  }

  const services = Object.entries(parsed.data.services).map(([name, svc]) => ({
    name,
    dockerfile: svc.dockerfile,
    context: svc.context,
    port: svc.port,
    public: svc.public,
    health: svc.health,
    env: svc.env ?? {},
    resources: svc.resources
      ? { memoryLimitMb: svc.resources.memory_mb, cpuLimit: svc.resources.cpus }
      : undefined,
    restart: svc.restart,
    maxRestartAttempts: svc.max_restart_attempts,
    dependsOn: svc.depends_on ?? [],
    volumes: svc.volumes ?? [],
  }));

  // Dependency sanity: unknown deps, self-deps, cycles.
  const deps: Record<string, string[]> = {};
  for (const svc of services) {
    for (const d of svc.dependsOn) {
      if (d === svc.name) throw new ManifestError(`service "${svc.name}" depends on itself`);
      if (!parsed.data.services[d]) {
        throw new ManifestError(`service "${svc.name}" depends on unknown service "${d}"`);
      }
    }
    deps[svc.name] = svc.dependsOn;
  }
  const cycle = findCycle(deps);
  if (cycle) {
    throw new ManifestError(`dependency cycle detected: ${cycle.join(' → ')}`);
  }

  // Volume references must be declared.
  const declared = new Set(Object.keys(parsed.data.volumes));
  for (const svc of services) {
    for (const mount of svc.volumes) {
      const volName = mount.split(':')[0]!;
      if (!declared.has(volName)) {
        throw new ManifestError(
          `service "${svc.name}" mounts undeclared volume "${volName}" (declare it under volumes:)`,
        );
      }
    }
  }

  // Public services need a port; at least one service must be public so the
  // application has a routable surface (workers-only apps are rejected —
  // deploy them as single private services of a larger app instead).
  const publicServices = services.filter((s) => s.public);
  if (publicServices.length === 0) {
    throw new ManifestError('at least one service must be public: true (the application has no routable surface)');
  }
  for (const svc of publicServices) {
    if (!svc.port) {
      throw new ManifestError(`public service "${svc.name}" must declare a port`);
    }
  }

  // File existence (when a repository directory is provided).
  const requiredFiles = services.map((svc) => {
    const dockerfile = path.posix.normalize(svc.dockerfile.replace(/\\/g, '/'));
    const context = path.posix.normalize(svc.context.replace(/\\/g, '/'));
    if (repoDir) {
      const abs = path.resolve(repoDir, dockerfile);
      if (!abs.startsWith(path.resolve(repoDir))) {
        throw new ManifestError(`service "${svc.name}": dockerfile escapes the repository`);
      }
      if (!existsSync(abs)) {
        throw new ManifestError(`service "${svc.name}": dockerfile not found at ${dockerfile}`);
      }
      if (!existsSync(path.resolve(repoDir, context))) {
        throw new ManifestError(`service "${svc.name}": context not found at ${context}`);
      }
    }
    return { service: svc.name, dockerfile, context };
  });

  const startOrder = topoSort(deps);
  return {
    manifest: {
      version: 1,
      services,
      volumes: parsed.data.volumes,
      startOrder,
    },
    requiredFiles,
  };
}

/**
 * Validate a STORED manifest snapshot (already normalized camelCase shape —
 * not raw YAML). Returns null when the snapshot is unusable.
 */
export function parseManifestSnapshot(snapshot: unknown): Manifest | null {
  const parsed = z
    .object({
      version: z.literal(1),
      services: z.array(
        z.object({
          name: serviceName,
          dockerfile: z.string(),
          context: z.string(),
          port: z.number().optional(),
          public: z.boolean(),
          health: z.object({ path: z.string() }).strict().optional(),
          env: z.record(z.string()).optional(),
          resources: z.object({ memoryLimitMb: z.number(), cpuLimit: z.number() }).strict().optional(),
          restart: z.enum(['disabled', 'on-failure']),
          maxRestartAttempts: z.number().int().min(0).max(10),
          dependsOn: z.array(z.string()),
          volumes: z.array(z.string()),
        }),
      ),
      volumes: z.record(z.object({ driver: z.literal('local') })),
      startOrder: z.array(z.string()),
    })
    .safeParse(snapshot);
  if (!parsed.success) return null;
  const services = parsed.data.services.map((svc) => ({ ...svc, env: svc.env ?? {} }));
  return { ...parsed.data, services };
}

/** Load and parse minicloud.yml from a cloned repository, if present. */
export async function loadManifest(repoDir: string): Promise<ParsedManifest | null> {
  const file = path.join(repoDir, MANIFEST_FILENAME);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, 'utf8');
  return parseManifest(raw, repoDir);
}
