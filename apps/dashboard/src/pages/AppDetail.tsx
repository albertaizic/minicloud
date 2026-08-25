import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import ConfigPanel from '../components/ConfigPanel.js';
import StatusBadge from '../components/StatusBadge.js';

/** Restart policy selector: disabled | on-failure with a bounded attempt budget. */
function RestartPolicyEditor({ appId, initial }: { appId: string; initial: { policy: string; maxRestartAttempts: number } }) {
  const [policy, setPolicy] = useState(initial.policy);
  const [max, setMax] = useState(String(initial.maxRestartAttempts));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setError('');
    setSaved(false);
    try {
      const parsed = Number(max);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) throw new Error('max attempts must be 0-10');
      const p = await api.setRestartPolicy(appId, policy, parsed);
      setPolicy(p.policy);
      setMax(String(p.maxRestartAttempts));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div>
      <p className="dim">
        on-failure: a crashed RUNNING deployment is restarted automatically with
        backoff, up to the attempt budget. Manual stop/restart resets the budget;
        stopped or deleted deployments never restart on their own.
      </p>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <select value={policy} onChange={(e) => setPolicy(e.target.value)}>
          <option value="disabled">disabled</option>
          <option value="on-failure">on-failure</option>
        </select>
        <input
          type="number"
          min={0}
          max={10}
          value={max}
          onChange={(e) => setMax(e.target.value)}
          style={{ width: '6em' }}
        />
        <button type="submit" className="primary">Save policy</button>
        {saved && <span className="dim">saved</span>}
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

export default function AppDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getApp>> | null>(null);
  const [error, setError] = useState('');
  const [confirmRollbackTo, setConfirmRollbackTo] = useState<string | null>(null);

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

  const [confirmForceStop, setConfirmForceStop] = useState(false);

  if (!data && !error) return <p>Loading…</p>;
  if (error) return <p className="error">{error} — <button onClick={load}>retry</button></p>;
  if (!data) return null;

  const latest = data.deployments[0];

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    setConfirmRollbackTo(null);
    try { await fn(); setTimeout(load, 400); } catch (e) { setError((e as Error).message); }
  };

  const rollbackTarget = data.deployments.find((d) => d.id === confirmRollbackTo);

  return (
    <div>
      <h1>{data.name}</h1>
      <p className="dim mono">{data.repositoryUrl}</p>
      <p>
        Stable URL:{' '}
        {data.url
          ? <a href={data.url} target="_blank" rel="noreferrer" className="mono">{data.url}</a>
          : <span className="dim">no active deployment</span>}
      </p>
      <div className="actions">
        <button className="primary" onClick={deployAgain}>Deploy again</button>
        {latest && (
          <>
            {confirmForceStop ? (
              <>
                <span className="error-text">Stopping the ACTIVE deployment makes {data.name} unavailable. </span>
                <button className="primary" onClick={() => act(() => api.stop(latest.id, { force: true })).then(() => setConfirmForceStop(false))}>Confirm force stop</button>
                <button onClick={() => setConfirmForceStop(false)}>Cancel</button>
              </>
            ) : (
              <button onClick={() => (latest!.isActive ? setConfirmForceStop(true) : act(() => api.stop(latest!.id, { force: true })))}>Stop latest</button>
            )}
            <button onClick={() => act(() => api.restart(latest.id))}>Restart latest</button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {data.url && (
        <p>
          Stable URL:{' '}
          <a href={data.url} target="_blank" rel="noreferrer" className="mono">{data.url}</a>
        </p>
      )}
      <h2>Restart policy</h2>
      <RestartPolicyEditor appId={data.id} initial={{ policy: data.restartPolicy, maxRestartAttempts: data.maxRestartAttempts }} />

      <h2>Configuration</h2>
      <ConfigPanel appId={data.id} />

      <h2>Deployments</h2>
      <table className="table">
        <thead>
          <tr><th>ID</th><th>Status</th><th>Commit</th><th>Port</th><th>Created</th><th></th></tr>
        </thead>
        <tbody>
          {data.deployments.map((d) => (
            <tr key={d.id}>
              <td><Link to={`/deployments/${d.id}`} className="mono">{d.id.slice(0, 8)}</Link></td>
              <td><StatusBadge status={d.status} />{d.isActive && <strong> ACTIVE</strong>}</td>
              <td className="mono dim">
                {d.commitSha?.slice(0, 7) ?? '—'}
                {d.rollbackOf ? <span title={`rollback of ${d.rollbackOf.slice(0, 8)}`}> ↩</span> : null}
              </td>
              <td className="mono">{d.hostPort ?? '—'}</td>
              <td className="dim">{new Date(d.createdAt).toLocaleString()}</td>
              <td>
                {d.imageTag && ['RUNNING', 'STOPPED', 'FAILED'].includes(d.status) && (
                  confirmRollbackTo === d.id ? (
                    <span>
                      Roll back to this revision?
                      {' '}
                      <button className="primary" onClick={() => act(() => api.rollback(data.id, d.id))}>Yes</button>
                      {' '}
                      <button onClick={() => setConfirmRollbackTo(null)}>Cancel</button>
                    </span>
                  ) : (
                    <button onClick={() => setConfirmRollbackTo(d.id)}>Rollback</button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rollbackTarget && (
        <p className="dim">
          Rollback creates a <strong>new</strong> deployment running revision{' '}
          <span className="mono">{rollbackTarget.commitSha?.slice(0, 7) ?? rollbackTarget.id.slice(0, 8)}</span> with
          the application's current configuration. Historical deployments are never modified.
        </p>
      )}
    </div>
  );
}
