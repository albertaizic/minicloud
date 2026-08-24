// Minimal HTTP client for the MiniCloud API. The CLI never duplicates
// deployment logic; it talks to the API.
const API_URL = process.env.MINICLOUD_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, `Cannot reach MiniCloud API at ${API_URL}. Is it running? (npm run dev)`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = (data as { error?: string; details?: Record<string, string[]> }).error ?? `HTTP ${res.status}`;
    const details = (data as { details?: Record<string, string[]> }).details;
    const detailStr = details ? ' ' + Object.entries(details).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : '';
    throw new ApiError(res.status, `${msg}${detailStr}`);
  }
  return data as T;
}

export interface AppDto {
  id: string;
  name: string;
  repositoryUrl: string;
  createdAt: string;
  latestDeployment?: { id: string; status: string; hostPort: number | null; commitSha: string | null } | null;
}

export interface LimitsDto {
  memoryLimitMb: number | null;
  cpuLimit: number | null;
}
export interface ConfigSnapshotDto {
  env: Record<string, string>;
  secretKeys: string[];
  limits: { memoryLimitMb?: number; cpuLimit?: number } | null;
}
export interface AppConfigDto {
  variables: { key: string; value: string; updatedAt: string }[];
  secrets: { key: string; updatedAt: string }[];
}
export interface DeploymentDto {
  id: string;
  applicationId: string;
  status: string;
  commitSha: string | null;
  hostPort: number | null;
  failureReason: string | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  url: string | null;
  config: ConfigSnapshotDto | null;
}

export const api = {
  createApp: (name: string, repositoryUrl: string) =>
    request<AppDto>('POST', '/api/apps', { name, repositoryUrl }),
  listApps: () => request<AppDto[]>('GET', '/api/apps'),
  getApp: (id: string) => request<Record<string, unknown>>('GET', `/api/apps/${id}`),
  deploy: (appId: string) => request<{ deployment: DeploymentDto }>('POST', `/api/apps/${appId}/deploy`, {}),
  listDeployments: () => request<DeploymentDto[]>('GET', '/api/deployments'),
  getDeployment: (id: string) => request<DeploymentDto>('GET', `/api/deployments/${id}`),
  stop: (id: string) => request<DeploymentDto>('POST', `/api/deployments/${id}/stop`),
  restart: (id: string) => request<DeploymentDto>('POST', `/api/deployments/${id}/restart`),
  deleteDeployment: (id: string) => request<void>('DELETE', `/api/deployments/${id}`),
  logs: (id: string) =>
    request<{ logs?: { message: string }[]; message?: string }>('GET', `/api/deployments/${id}/logs`),
  streamLogs: (id: string, onLine: (line: string) => void): Promise<() => void> => {
    return new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      fetch(`${API_URL}/api/deployments/${id}/logs`, {
        headers: { accept: 'text/event-stream' },
        signal: ctrl.signal,
      })
        .then((res) => {
          if (!res.ok || !res.body) {
            reject(new ApiError(res.status, `Log stream unavailable (HTTP ${res.status})`));
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const pump = async (): Promise<void> => {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              for (const line of decoder.decode(value).split('\n')) {
                if (line.startsWith('data: ')) {
                  try {
                    const evt = JSON.parse(line.slice(6)) as { message: string };
                    onLine(evt.message);
                  } catch {
                    /* ignore malformed frames */
                  }
                }
              }
            }
          };
          void pump().catch(() => {});
          resolve(() => ctrl.abort());
        })
        .catch((err) => reject(err instanceof ApiError ? err : new ApiError(0, String(err))));
    });
  },
};

// ---- application configuration (env / secrets / limits) --------------------

export const configApi = {
  listEnv: (appId: string) => request<AppConfigDto>('GET', `/api/apps/${appId}/env`),
  setEnvVar: (appId: string, key: string, value: string) =>
    request<{ key: string }>('PUT', `/api/apps/${appId}/env/${encodeURIComponent(key)}`, { value }),
  deleteKey: (appId: string, key: string) =>
    request<void>('DELETE', `/api/apps/${appId}/env/${encodeURIComponent(key)}`),
  setSecret: (appId: string, key: string, value: string) =>
    request<{ key: string }>('PUT', `/api/apps/${appId}/secrets/${encodeURIComponent(key)}`, { value }),
  deleteSecret: (appId: string, key: string) =>
    request<void>('DELETE', `/api/apps/${appId}/secrets/${encodeURIComponent(key)}`),
  getLimits: (appId: string) => request<LimitsDto>('GET', `/api/apps/${appId}/limits`),
  setLimits: (appId: string, limits: { memoryLimitMb?: number; cpuLimit?: number }) =>
    request<LimitsDto>('PUT', `/api/apps/${appId}/limits`, limits),
  clearLimits: (appId: string) => request<LimitsDto>('DELETE', `/api/apps/${appId}/limits`),
};

// ---- Short-ID resolution ---------------------------------------------------
// The CLI displays 8-character ID prefixes. Any command accepting an
// application/deployment id also accepts such a prefix, as long as it is
// unambiguous among the currently known objects.

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{4,12}$/i;

export class AmbiguousIdError extends Error {
  constructor(kind: string, prefix: string, matches: string[]) {
    super(
      `Ambiguous ${kind} id "${prefix}" matches ${matches.length} entries:\n` +
        matches.map((m) => `  ${m}`).join('\n') +
        `\nUse a longer prefix.`,
    );
    this.name = 'AmbiguousIdError';
  }
}

export function isFullUuid(id: string): boolean {
  return FULL_UUID_RE.test(id);
}

/** Resolve a possibly-short deployment id to its full UUID via /api/deployments. */
export async function resolveDeploymentId(idOrPrefix: string): Promise<string> {
  if (isFullUuid(idOrPrefix)) return idOrPrefix;
  const deps = await api.listDeployments();
  const matches = deps.filter((d) => d.id.startsWith(idOrPrefix)).map((d) => d.id);
  if (matches.length === 0) return idOrPrefix; // let the API produce the not-found error
  if (matches.length > 1) throw new AmbiguousIdError('deployment', idOrPrefix, matches);
  return matches[0]!;
}

/** Resolve a possibly-short app id (or name) to its full UUID. */
export async function resolveAppId(idOrPrefixOrName: string): Promise<string> {
  const apps: AppDto[] = await api.listApps();
  const byName = apps.find((a) => a.name === idOrPrefixOrName);
  if (byName) return byName.id;
  if (isFullUuid(idOrPrefixOrName)) return idOrPrefixOrName;
  const matches = apps.filter((a) => a.id.startsWith(idOrPrefixOrName)).map((a) => a.id);
  if (matches.length === 0) return idOrPrefixOrName;
  if (matches.length > 1) throw new AmbiguousIdError('application', idOrPrefixOrName, matches);
  return matches[0]!;
}

/** Validate shape early so garbage like "abc" fails fast with a clear message. */
export function assertPlausibleId(id: string): void {
  if (!id || !(FULL_UUID_RE.test(id) || SHORT_ID_RE.test(id))) {
    throw new Error(`"${id}" is not a valid deployment or application id`);
  }
}
