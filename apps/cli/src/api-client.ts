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
