// Dashboard API helpers. In dev, Vite proxies /api to the MiniCloud API.
const BASE = import.meta.env.VITE_API_URL ?? '';

export interface AppDto {
  id: string;
  name: string;
  repositoryUrl: string;
  createdAt: string;
  routeSlug: string | null;
  url: string | null;
  activeDeploymentId: string | null;
  restartPolicy: string;
  maxRestartAttempts: number;
  latestDeployment?: {
    id: string;
    status: string;
    hostPort: number | null;
    commitSha: string | null;
    createdAt: string;
  } | null;
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
  ref: string | null;
  commitSha: string | null;
  status: string;
  imageTag: string | null;
  containerName: string | null;
  hostPort: number | null;
  containerPort: number | null;
  failureReason: string | null;
  exitCode: number | null;
  restartCount: number;
  autoRestartCount: number;
  rollbackOf: string | null;
  isActive: boolean;
  multiService: boolean;
  services: Array<{
    service: string;
    status: string;
    public: boolean;
    containerName: string | null;
    hostPort: number | null;
    restartCount: number;
    failureReason: string | null;
  }> | null;
  config: ConfigSnapshotDto | null;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
  url: string | null;
}

export interface DeploymentEventDto {
  id: string;
  type: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MetricsDto {
  status: string;
  restartCount: number;
  autoRestartCount: number;
  startedAt: string | null;
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
}

export interface RestartPolicyDto {
  policy: string;
  maxRestartAttempts: number;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  listApps: () => req<AppDto[]>('/api/apps'),
  getApp: (id: string) => req<AppDto & { deployments: DeploymentDto[] }>(`/api/apps/${id}`),
  createApp: (name: string, repositoryUrl: string) =>
    req<AppDto>('/api/apps', { method: 'POST', body: JSON.stringify({ name, repositoryUrl }) }),
  deploy: (appId: string) => req<{ deployment: DeploymentDto }>(`/api/apps/${appId}/deploy`, { method: 'POST', body: '{}' }),
  getDeployment: (id: string) => req<DeploymentDto>(`/api/deployments/${id}`),
  stop: (id: string, opts: { force?: boolean } = {}) =>
    req<DeploymentDto>(`/api/deployments/${id}/stop${opts.force ? '?force=true' : ''}`, { method: 'POST' }),
  restart: (id: string) => req<DeploymentDto>(`/api/deployments/${id}/restart`, { method: 'POST' }),
  rollback: (appId: string, targetDeploymentId: string) =>
    req<{ deployment: DeploymentDto }>(`/api/apps/${appId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ targetDeploymentId }),
    }),
  getEvents: (id: string) =>
    req<{ events: DeploymentEventDto[] }>(`/api/deployments/${id}/events`),
  getMetrics: (id: string) => req<MetricsDto>(`/api/deployments/${id}/metrics`),
  getRestartPolicy: (appId: string) =>
    req<RestartPolicyDto>(`/api/apps/${appId}/restart-policy`),
  getVolumes: (appId: string) =>
    req<{ volumes: Array<{ name: string; dockerVolume: string; createdAt: string }> }>(`/api/apps/${appId}/volumes`),
  getRoutes: () =>
    req<{
      gatewayPort: number;
      routes: Array<{
        slug: string;
        url: string;
        appName: string | null;
        deploymentId: string;
        upstream: { host: string; port: number };
        activeSince: string;
        stats: { requests: number; active: number; ok2xx: number; client4xx: number; server5xx: number };
      }>;
    }>('/api/routes'),
  setRestartPolicy: (appId: string, policy: string, maxRestartAttempts?: number) =>
    req<RestartPolicyDto>(`/api/apps/${appId}/restart-policy`, {
      method: 'PUT',
      body: JSON.stringify({ policy, ...(maxRestartAttempts !== undefined ? { maxRestartAttempts } : {}) }),
    }),
};

export const configApi = {
  listEnv: (appId: string) => req<AppConfigDto>(`/api/apps/${appId}/env`),
  setEnvVar: (appId: string, key: string, value: string) =>
    req<{ key: string }>(`/api/apps/${appId}/env/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteEnvKey: (appId: string, key: string) =>
    req<void>(`/api/apps/${appId}/env/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  setSecret: (appId: string, key: string, value: string) =>
    req<{ key: string }>(`/api/apps/${appId}/secrets/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteSecret: (appId: string, key: string) =>
    req<void>(`/api/apps/${appId}/secrets/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  getLimits: (appId: string) => req<LimitsDto>(`/api/apps/${appId}/limits`),
  setLimits: (appId: string, limits: { memoryLimitMb?: number; cpuLimit?: number }) =>
    req<LimitsDto>(`/api/apps/${appId}/limits`, { method: 'PUT', body: JSON.stringify(limits) }),
  clearLimits: (appId: string) => req<LimitsDto>(`/api/apps/${appId}/limits`, { method: 'DELETE' }),
};
