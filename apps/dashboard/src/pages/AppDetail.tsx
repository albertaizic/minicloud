import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import ConfigPanel from '../components/ConfigPanel.js';
import StatusBadge from '../components/StatusBadge.js';

export default function AppDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getApp>> | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!id) return;
    api.getApp(id).then(setData).catch((e) => setError(e.message));
  }, [id]);
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);

  const deployAgain = async () => {
    if (!id || !data) return;
    setError('');
    try {
      await api.deploy(id);
      setTimeout(load, 300);
    } catch (e) { setError((e as Error).message); }
  };

  if (!data && !error) return <p>Loading…</p>;
  if (error) return <p className="error">{error} — <button onClick={load}>retry</button></p>;
  if (!data) return null;

  const latest = data.deployments[0];

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); setTimeout(load, 400); } catch (e) { setError((e as Error).message); }
  };

  return (
    <div>
      <h1>{data.name}</h1>
      <p className="dim mono">{data.repositoryUrl}</p>
      <div className="actions">
        <button className="primary" onClick={deployAgain}>Deploy again</button>
        {latest && (
          <>
            <button onClick={() => act(() => api.stop(latest.id))}>Stop latest</button>
            <button onClick={() => act(() => api.restart(latest.id))}>Restart latest</button>
          </>
        )}
      </div>
      <h2>Configuration</h2>
      <ConfigPanel appId={data.id} />
      <h2>Deployments</h2>
      <table className="table">
        <thead>
          <tr><th>ID</th><th>Status</th><th>Commit</th><th>Port</th><th>Created</th></tr>
        </thead>
        <tbody>
          {data.deployments.map((d) => (
            <tr key={d.id}>
              <td><Link to={`/deployments/${d.id}`} className="mono">{d.id.slice(0, 8)}</Link></td>
              <td><StatusBadge status={d.status} /></td>
              <td className="mono dim">{d.commitSha?.slice(0, 7) ?? '—'}</td>
              <td className="mono">{d.hostPort ?? '—'}</td>
              <td className="dim">{new Date(d.createdAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
