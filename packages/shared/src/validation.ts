import { z } from 'zod';

// Public https remotes, ssh remotes, and http(s) remotes on localhost/127.0.0.1
// (useful for local git servers such as Gitea). Everything else is rejected.
const REPO_URL_RE =
  /^(https:\/\/[\w.-]+(:\d+)?\/[\w~%.\-]+(\/[%\w~.\-]+)*(\.git)?\/?|git@[\w.-]+:[\w~%.\-]+\/[\w~%.\-]+(\.git)?)$/;
const LOCAL_URL_RE = /^https?:\/\/localhost(:\d+)?\/[\w~%.\-]+(\.git)?$/;

function repoUrlAllowed(url: string): boolean {
  return REPO_URL_RE.test(url) || LOCAL_URL_RE.test(url);
}

export const createAppSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/i, 'name must be alphanumeric with dashes'),
  repositoryUrl: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(repoUrlAllowed, 'repositoryUrl must be a public https or ssh git URL (localhost http allowed)'),
});

export type CreateAppInput = z.infer<typeof createAppSchema>;

export const deployAppSchema = z.object({
  ref: z.string().trim().max(200).regex(/^[\w.\-/]+$/, 'invalid git ref').optional(),
  healthPath: z.string().trim().max(200).regex(/^\/[\w\-./]*$/, 'healthPath must start with /').optional(),
  containerPort: z.number().int().min(1).max(65535).optional(),
  healthTimeoutSeconds: z.number().int().min(5).max(600).optional(),
}).strict();

export type DeployAppInput = z.infer<typeof deployAppSchema>;

/** Validate a raw id used in URLs (uuids). */
export function isValidId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

// ---- Application configuration (v0.2) --------------------------------------

/** Env var / secret key: POSIX-ish identifier. No '=' or NUL, no leading digit, bounded length. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const envKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(ENV_KEY_RE, 'key must match [A-Za-z_][A-Za-z0-9_]*');

export const envValueSchema = z.string().max(8192);

export const setEnvVarSchema = z.object({
  key: envKeySchema,
  value: envValueSchema,
}).strict();

export type SetEnvVarInput = z.infer<typeof setEnvVarSchema>;

export const setSecretSchema = z.object({
  key: envKeySchema,
  value: envValueSchema,
}).strict();

export type SetSecretInput = z.infer<typeof setSecretSchema>;

// Resource limits.
//  memoryLimitMb: Docker memory limit in MB; hard bounds keep typos like
//  "99999999" from starving the host.
//  cpuLimit: number of CPUs as a fractional quota (Docker --cpus), e.g. 0.5 .. 8.
export const MEMORY_LIMIT_MIN_MB = 16;
export const MEMORY_LIMIT_MAX_MB = 65536;
export const CPU_LIMIT_MIN = 0.1;
export const CPU_LIMIT_MAX = 64;

export const resourceLimitsSchema = z
  .object({
    memoryLimitMb: z
      .number()
      .int()
      .min(MEMORY_LIMIT_MIN_MB, `memoryLimitMb must be >= ${MEMORY_LIMIT_MIN_MB}`)
      .max(MEMORY_LIMIT_MAX_MB, `memoryLimitMb must be <= ${MEMORY_LIMIT_MAX_MB}`)
      .optional(),
    cpuLimit: z
      .number()
      .min(CPU_LIMIT_MIN, `cpuLimit must be >= ${CPU_LIMIT_MIN}`)
      .max(CPU_LIMIT_MAX, `cpuLimit must be <= ${CPU_LIMIT_MAX}`)
      .optional(),
  })
  .strict()
  .refine((v) => v.memoryLimitMb !== undefined || v.cpuLimit !== undefined, {
    message: 'at least one of memoryLimitMb or cpuLimit is required',
  });

export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;

export const updateLimitsSchema = resourceLimitsSchema;

/**
 * Effective runtime configuration for one deployment. Secrets are represented
 * by KEY names only — values are resolved at container start and never stored
 * in the snapshot.
 */
export interface DeploymentConfigSnapshot {
  env: Record<string, string>;
  secretKeys: string[];
  limits: { memoryLimitMb?: number; cpuLimit?: number } | null;
}

/** Build the non-secret snapshot recorded on each deployment row. */
export function buildConfigSnapshot(
  env: Record<string, string>,
  secretKeys: string[],
  limits: ResourceLimits | null,
): DeploymentConfigSnapshot {
  return {
    env,
    secretKeys: [...secretKeys].sort(),
    limits: limits ? { ...limits } : null,
  };
}

