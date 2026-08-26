/** Deployment lifecycle states. */
export type DeploymentStatus =
  | 'QUEUED'
  | 'CLONING'
  | 'BUILDING'
  | 'STARTING'
  | 'HEALTH_CHECKING'
  | 'RUNNING'
  | 'FAILED'
  | 'STOPPED'
  | 'CANCELLED';

/**
 * Explicit state machine for deployment transitions.
 *
 * Normal path:
 *   QUEUED -> CLONING -> BUILDING -> STARTING -> HEALTH_CHECKING -> RUNNING
 * Terminal-ish states:
 *   FAILED (from any non-terminal state, or RUNNING via unexpected exit)
 *   STOPPED (from RUNNING or STARTING+ by explicit user stop)
 *   CANCELLED (from any non-RUNNING in-flight state by explicit user cancel;
 *     a RUNNING deployment cannot be "cancelled" — stopping it is a different,
 *     destructive act and is rejected by the cancel endpoint)
 */
export const ALLOWED_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ['CLONING', 'FAILED', 'CANCELLED'],
  CLONING: ['BUILDING', 'FAILED', 'CANCELLED'],
  BUILDING: ['STARTING', 'FAILED', 'CANCELLED'],
  STARTING: ['HEALTH_CHECKING', 'FAILED', 'STOPPED', 'CANCELLED'],
  HEALTH_CHECKING: ['RUNNING', 'FAILED', 'STOPPED', 'CANCELLED'],
  RUNNING: ['FAILED', 'STOPPED'],
  FAILED: [],
  STOPPED: [],
  CANCELLED: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: DeploymentStatus,
    public readonly to: DeploymentStatus,
  ) {
    super(`Invalid deployment status transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/** Statuses that indicate the deployment is in flight (owned by the engine). */
export function isActive(status: DeploymentStatus): boolean {
  return (
    status === 'QUEUED' ||
    status === 'CLONING' ||
    status === 'BUILDING' ||
    status === 'STARTING' ||
    status === 'HEALTH_CHECKING'
  );
}

/** Statuses a deployment can be cancelled from (never RUNNING — see above). */
export function isCancellable(status: DeploymentStatus): boolean {
  return (
    status === 'QUEUED' ||
    status === 'CLONING' ||
    status === 'BUILDING' ||
    status === 'STARTING' ||
    status === 'HEALTH_CHECKING'
  );
}

/** Statuses in which a container may exist and could be serving traffic. */
export function isServing(status: DeploymentStatus): boolean {
  return status === 'RUNNING';
}
