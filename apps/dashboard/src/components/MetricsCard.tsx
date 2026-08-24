import { useEffect, useState } from 'react';
import { api, type MetricsDto } from '../api.js';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatUptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Live runtime metrics for a RUNNING deployment. Polls every 3 seconds only
 * while the deployment is running; the interval is always cleaned up on
 * unmount. Non-running deployments show a short explanation instead of fake
 * zero metrics.
 */
export default function MetricsCard({ deploymentId, status }: { deploymentId: string; status: string }) {
  const [metrics, setMetrics] = useState<MetricsDto | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'RUNNING') {
      setMetrics(null);
      setUnavailable(`Metrics are only available while the deployment is RUNNING (current: ${status}).`);
      return;
    }
    let cancelled = false;
    const load = () => {
      api
        .getMetrics(deploymentId)
        .then((m) => {
          if (!cancelled) {
            setMetrics(m);
            setUnavailable(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setUnavailable(e.message);
        });
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [deploymentId, status]);

  if (unavailable) return <p className="dim">{unavailable}</p>;
  if (!metrics) return <p className="dim">Loading metrics…</p>;

  return (
    <dl className="detail-grid">
      <dt>CPU</dt><dd className="mono">{metrics.cpuPercent.toFixed(1)}%</dd>
      <dt>Memory</dt>
      <dd className="mono">
        {formatBytes(metrics.memoryUsedBytes)}
        {metrics.memoryLimitBytes > 0 ? ` / ${formatBytes(metrics.memoryLimitBytes)} (${metrics.memoryPercent.toFixed(1)}%)` : ' (no limit)'}
      </dd>
      <dt>Uptime</dt><dd>{formatUptime(metrics.startedAt)}</dd>
      <dt>Restarts</dt>
      <dd>
        {metrics.restartCount}
        {metrics.autoRestartCount > 0 ? <span className="dim"> ({metrics.autoRestartCount} automatic)</span> : null}
      </dd>
    </dl>
  );
}
