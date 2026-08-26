// Preview environments panel (v0.7): GitHub pull-request previews for one
// application. Preview traffic is clearly labelled — it never touches the
// production route.
import { useCallback, useEffect, useState } from 'react';
import { api, type PreviewEnvDto } from '../api.js';

const STATUS_CLASS: Record<PreviewEnvDto['status'], string> = {
  creating: 'building',
  active: 'running',
  closed: 'stopped',
};

function sha(s: string | null): string {
  return s ? s.slice(0, 12) : '—';
}

export default function PreviewsPanel({ appId }: { appId: string }) {
  const [previews, setPreviews] = useState<PreviewEnvDto[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.listPreviews(appId).then((r) => setPreviews(r.previews)).catch((e) => setError(e.message));
  }, [appId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const close = async (prNumber: number) => {
    setError('');
    try {
      await api.deletePreview(appId, prNumber);
      setTimeout(load, 300);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!previews || previews.length === 0) return null;
  const open = previews.filter((p) => p.status !== 'closed');
  const closed = previews.filter((p) => p.status === 'closed');

  return (
    <div>
      <h2>Preview environments</h2>
      <p className="dim">
        One isolated preview per pull request: ephemeral storage, its own network, and a{' '}
        <span className="mono">pr-&lt;number&gt;</span> URL. Previews never receive production
        secrets or volumes unless explicitly enabled.
      </p>
      {open.length === 0 && <p className="dim">No open previews.</p>}
      {open.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>PREVIEW · PR</th>
              <th>State</th>
              <th>Head</th>
              <th>URL</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {open.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>PREVIEW</strong> · PR #{p.prNumber}
                  {p.branch && <span className="dim"> ({p.branch})</span>}
                </td>
                <td>
                  <span className={`badge badge-${STATUS_CLASS[p.status]}`}>
                    <span className="dot" />
                    {p.status}
                  </span>
                </td>
                <td className="mono">{sha(p.headSha)}</td>
                <td>
                  {p.url && p.status === 'active' ? (
                    <a href={p.url} target="_blank" rel="noreferrer" className="mono">{p.url}</a>
                  ) : (
                    <span className="dim mono">{p.url ?? '—'}</span>
                  )}
                </td>
                <td className="dim">{new Date(p.updatedAt).toLocaleString()}</td>
                <td>
                  <button onClick={() => close(p.prNumber)}>Delete preview</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {closed.length > 0 && (
        <details>
          <summary className="dim">{closed.length} closed preview{closed.length === 1 ? '' : 's'}</summary>
          <ul>
            {closed.map((p) => (
              <li key={p.id} className="dim">
                PR #{p.prNumber} · {sha(p.headSha)} · closed {p.closedAt ? new Date(p.closedAt).toLocaleString() : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
