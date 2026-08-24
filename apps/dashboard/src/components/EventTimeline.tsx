import { useEffect, useState } from 'react';
import { api, type DeploymentEventDto } from '../api.js';

/**
 * Chronological lifecycle event timeline for one deployment. Events come from
 * the persistent deployment_events table (ordered by a monotonic sequence), so
 * the timeline survives API restarts and does not depend on log retention.
 */
export default function EventTimeline({ deploymentId }: { deploymentId: string }) {
  const [events, setEvents] = useState<DeploymentEventDto[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .getEvents(deploymentId)
        .then((r) => {
          if (!cancelled) setEvents(r.events);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    };
    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [deploymentId]);

  if (error) return <p className="error">{error}</p>;
  if (!events) return <p className="dim">Loading events…</p>;
  if (events.length === 0) return <p className="dim">No events recorded.</p>;

  return (
    <table className="table">
      <thead>
        <tr><th>Time</th><th>Event</th><th>Details</th></tr>
      </thead>
      <tbody>
        {events.map((e) => (
          <tr key={e.id}>
            <td className="dim mono">{new Date(e.createdAt).toLocaleTimeString()}</td>
            <td className="mono">{e.type}</td>
            <td className="dim">{e.message}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
