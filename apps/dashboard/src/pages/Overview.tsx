import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AppDto } from '../api.js';
import StatusBadge from '../components/StatusBadge.js';

export default function Overview() {
  const [apps, setApps] = useState<AppDto[] | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.listApps().then(setApps).catch((e) => setError(String(e.message)));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.createApp(name.trim(), url.trim());
      setName('');
      setUrl('');
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1>Applications</h1>
      <form onSubmit={submit} className="new-app-form">
        <input placeholder="app-name" value={name} onChange={(e) => setName(e.target.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9-]*" />
        <input placeholder="https://github.com/user/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} required style={{ flex: 2 }} />
        <button disabled={busy}>{busy ? 'Creating…' : 'Create app'}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {!apps && <p>Loading…</p>}
      {apps && apps.length === 0 && <p className="empty">No applications yet. Create one above or use the CLI: <code>minicloud deploy https://github.com/…</code></p>}
      <table className="table">
        <thead>
          <tr><th>App</th><th>Repository</th><th>Latest deployment</th><th>Status</th><th>Stable URL</th><th>Internal</th></tr>
        </thead>
        <tbody>
          {(apps ?? []).map((a) => (
            <tr key={a.id}>
              <td><Link to={`/apps/${a.id}`}>{a.name}</Link></td>
              <td className="mono dim">{a.repositoryUrl}</td>
              <td>{a.latestDeployment ? <Link to={`/deployments/${a.latestDeployment.id}`} className="mono">{a.latestDeployment.id.slice(0, 8)}</Link> : <span className="dim">—</span>}</td>
              <td>{a.latestDeployment ? <StatusBadge status={a.latestDeployment.status} /> : <span className="dim">never deployed</span>}</td>
              <td>{a.url ? <a href={a.url} target="_blank" rel="noreferrer" className="mono">{a.url}</a> : <span className="dim">no active deployment</span>}</td>
              <td>{a.latestDeployment?.hostPort ? <span className="mono dim">:{a.latestDeployment.hostPort}</span> : <span className="dim">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
