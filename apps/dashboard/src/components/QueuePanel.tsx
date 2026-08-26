// Queue visibility (v0.7): what is building right now, what is waiting, and
// which request produced it. Cancel acts on queued or in-flight work; RUNNING
// deployments are deliberately not cancellable here (stop/rollback own that).
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type QueueJobDto, type QueueSnapshotDto } from '../api.js';
import StatusBadge from './StatusBadge.js';

const TRIGGER_LABEL: Record<string, string> = {
  manual: 'manual',
  git: 'git push',
  preview: 'PR preview',
};

function TriggerChip({ trigger }: { trigger: string }) {
  return <span className="dim">{TRIGGER_LABEL[trigger] ?? trigger}</span>;
}

function JobRow({ job, onCancel }: { job: QueueJobDto; onCancel: (deploymentId: string) => void }) {
  return (
    <tr>
      <td>
        <Link to={`/deployments/${job.deploymentId}`} className="mono">
          {job.deploymentId.slice(0, 8)}
        </Link>
      </td>
      <td>{job.status === 'queued' ? <StatusBadge status="QUEUED" /> : <StatusBadge status="BUILDING" />}</td>
      <td><TriggerChip trigger={job.trigger} /></td>
      <td className="dim">
        {job.status === 'queued' && job.position != null
          ? `waiting · position ${job.position}${job.position === 1 ? ' (next)' : ''}`
          : `claimed ${new Date(job.createdAt).toLocaleTimeString()}`}
      </td>
      <td>
        {job.status !== 'running' ? (
          <button onClick={() => onCancel(job.deploymentId)}>Cancel</button>
        ) : (
          <span className="dim">running…</span>
        )}
      </td>
    </tr>
  );
}

export default function QueuePanel({ appId }: { appId?: string }) {
  const [snapshot, setSnapshot] = useState<QueueSnapshotDto | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api.getQueue(appId).then(setSnapshot).catch((e) => setError(e.message));
  }, [appId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [load]);

  const cancel = async (deploymentId: string) => {
    setError('');
    try {
      await api.cancelDeployment(deploymentId);
      setTimeout(load, 300);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error && !snapshot) return <p className="error">{error}</p>;
  if (!snapshot) return null;
  const busy = snapshot.running.length > 0 || snapshot.queued.length > 0;

  return (
    <div>
      <p className="dim">
        Build queue — up to {snapshot.limit} deployment{snapshot.limit === 1 ? '' : 's'} build at once;
        one at a time per application. Manual deploys run before git pushes and previews.
      </p>
      {!busy ? (
        <p className="dim">Queue is empty.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Deployment</th>
              <th>State</th>
              <th>Source</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {snapshot.running.map((j) => (
              <JobRow key={j.jobId} job={j} onCancel={cancel} />
            ))}
            {snapshot.queued.map((j) => (
              <JobRow key={j.jobId} job={j} onCancel={cancel} />
            ))}
          </tbody>
        </table>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
