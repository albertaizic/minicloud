const CLASS: Record<string, string> = {
  QUEUED: 'queued',
  CLONING: 'building',
  BUILDING: 'building',
  STARTING: 'building',
  HEALTH_CHECKING: 'building',
  RUNNING: 'running',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

const LABELS: Record<string, string> = {
  QUEUED: 'queued',
  CLONING: 'cloning',
  BUILDING: 'building',
  STARTING: 'starting',
  HEALTH_CHECKING: 'health check',
  RUNNING: 'running',
  FAILED: 'failed',
  STOPPED: 'stopped',
};

export default function StatusBadge({ status }: { status: string }) {
  const cls = CLASS[status] ?? 'queued';
  return (
    <span className={`badge badge-${cls}`}>
      <span className="dot" />
      {LABELS[status] ?? status.toLowerCase()}
    </span>
  );
}
