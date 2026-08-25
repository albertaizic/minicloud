import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.js';
import LogStream from '../components/LogStream.js';
import MetricsCard from '../components/MetricsCard.js';
import EventTimeline from '../components/EventTimeline.js';

export default function DeploymentDetail() {
  const { id } = useParams<{ id: string }>();
  const [dep, setDep] = useState<Awaited<ReturnType<typeof api.getDeployment>> | null>(null);
  const [appName, setAppName] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!id) return;
    api.getDeployment(id)
      .then(async (d) => {
        setDep(d);
        try {
          const app = await api.getApp(d.applicationId);
          setAppName(app.name);
        } catch { /* app may be gone */ }
      })
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  if (!dep && !error) return <p>Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  if (!dep) return null;

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); setTimeout(load, 400); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div>
      <p><Link to="/">← Overview</Link>{appName && <> · <Link to={`/apps/${dep.applicationId}`}>{appName}</Link></>}</p>
      <h1>
        Deployment <span className="mono">{dep.id.slice(0, 8)}</span>
        {dep.isActive && <strong> ACTIVE</strong>}
      </h1>
      <div className="detail-grid">
        <div><StatusBadge status={dep.status} /></div>
        <dl>
          <dt>Commit</dt><dd className="mono">{dep.commitSha?.slice(0, 12) ?? '—'}</dd>
          <dt>Ref</dt><dd className="mono">{dep.ref ?? '—'}</dd>
          <dt>Container</dt><dd className="mono">{dep.containerName ?? '—'}</dd>
          <dt>Container URL</dt>
          <dd>{dep.url
            ? <a href={dep.url} target="_blank" rel="noreferrer">{dep.url}</a>
            : <span className="dim">not serving</span>}</dd>
          <dt>Created</dt><dd>{new Date(dep.createdAt).toLocaleString()}</dd>
          {dep.startedAt && (<><dt>Started</dt><dd>{new Date(dep.startedAt).toLocaleString()}</dd></>)}
          {dep.stoppedAt && (<><dt>Stopped</dt><dd>{new Date(dep.stoppedAt).toLocaleString()}</dd></>)}
          {dep.restartCount > 0 && (
            <><dt>Restarts</dt><dd>{dep.restartCount}{dep.autoRestartCount > 0 ? <span className="dim"> ({dep.autoRestartCount} automatic)</span> : null}</dd></>
          )}
          {dep.rollbackOf && (
            <>
              <dt>Rollback of</dt>
              <dd><Link to={`/deployments/${dep.rollbackOf}`} className="mono">{dep.rollbackOf.slice(0, 8)}</Link></dd>
            </>
          )}
          {dep.exitCode !== null && (<><dt>Exit code</dt><dd className="mono">{dep.exitCode}</dd></>)}
          {dep.failureReason && (<><dt>Failure</dt><dd className="error-text">{dep.failureReason}</dd></>)}
        </dl>
      </div>
      <div className="actions">
        <button onClick={() => act(() => api.restart(dep.id))}>Restart</button>
        <button onClick={() => act(() => api.stop(dep.id))}>Stop</button>
      </div>
      {error && <p className="error">{error}</p>}
      {dep.services && dep.services.length > 0 && (
        <>
          <h2>Services</h2>
          <table className="table">
            <thead>
              <tr><th>Service</th><th>Status</th><th>Visibility</th><th>Host port</th><th>Restarts</th></tr>
            </thead>
            <tbody>
              {dep.services.map((sv) => (
                <tr key={sv.service}>
                  <td className="mono">{sv.service}</td>
                  <td><StatusBadge status={sv.status} /></td>
                  <td>{sv.public ? 'public' : 'private'}</td>
                  <td className="mono">{sv.hostPort ?? '—'}</td>
                  <td>{sv.restartCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h2>Metrics</h2>
      <MetricsCard deploymentId={dep.id} status={dep.status} />
      <h2>Events</h2>
      <EventTimeline deploymentId={dep.id} />
      {dep.config && (
        <>
          <h2>Configuration used by this deployment</h2>
          <p className="dim">
            Snapshot of the effective non-secret configuration captured when the
            container was (re)started. Secret values are never recorded.
          </p>
          <table className="table">
            <thead>
              <tr><th>Variable</th><th>Value</th></tr>
            </thead>
            <tbody>
              {Object.entries(dep.config.env).map(([k, v]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="mono">{v}</td>
                </tr>
              ))}
              {dep.config.secretKeys.map((k) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="mono dim">•••••••• (secret)</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="dim">
            Resource limits:{' '}
            {dep.config.limits
              ? `${dep.config.limits.memoryLimitMb ?? '—'} MB memory, ${dep.config.limits.cpuLimit ?? '—'} CPUs`
              : 'none'}
          </p>
        </>
      )}
      <h2>Logs</h2>
      <LogStream deploymentId={dep.id} />
    </div>
  );
}
