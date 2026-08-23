// Health checking: bounded HTTP polling against the deployed container's
// host-mapped port.
export interface HealthCheckOptions {
  hostPort: number;
  path: string;
  timeoutSeconds: number;
  intervalSeconds: number;
  onAttempt?: (attempt: number, error?: string) => void;
  signal?: AbortSignal;
}

const CONNECT_TIMEOUT_MS = 2000;

export async function checkOnce(opts: { hostPort: number; path: string }): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    const res = await fetch(`http://127.0.0.1:${opts.hostPort}${opts.path}`, {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'user-agent': 'minicloud-healthcheck' },
    });
    // Any response - even 500 - proves the server is up enough to answer HTTP.
    if (res.body) await res.body.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}

/** Poll until healthy or the deadline expires. */
export async function waitForHealthy(opts: HealthCheckOptions): Promise<{ ok: boolean; lastError?: string }> {
  const deadline = Date.now() + opts.timeoutSeconds * 1000;
  let attempt = 0;
  let lastError = '';
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) return { ok: false, lastError: 'aborted' };
    attempt++;
    try {
      await checkOnce(opts);
      return { ok: true };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      opts.onAttempt?.(attempt, lastError);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(opts.intervalSeconds * 1000, remaining), opts.signal);
  }
  return { ok: false, lastError: lastError || 'health check timed out' };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
