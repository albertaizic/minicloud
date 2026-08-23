/** Deployment lifecycle states. */
export type DeploymentStatus =
  | 'QUEUED'
  | 'CLONING'
  | 'BUILDING'
  | 'STARTING'
  | 'HEALTH_CHECKING'
  | 'RUNNING'
  | 'FAILED'
  | 'STOPPED';

/**
 * Explicit state machine for deployment transitions.
 *
 * Normal path:
 *   QUEUED -> CLONING -> BUILDING -> STARTING -> HEALTH_CHECKING -> RUNNING
 * Terminal-ish states:
 *   FAILED (from any non-terminal state, or RUNNING via unexpected exit)
 *   STOPPED (from RUNNING or STARTING+ by explicit user stop)
 */
export const ALLOWED_TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ['CLONING', 'FAILED', 'CANCELLED' as DeploymentStatus].filter(
    (s) => s !== 'CANCELLED',
  ) as DeploymentStatus[],
  CLONING: ['BUILDING', 'FAILED'],
  BUILDING: ['STARTING', 'FAILED'],
  STARTING: ['HEALTH_CHECKING', 'FAILED', 'STOPPED'],
  HEALTH_CHECKING: ['RUNNING', 'FAILED', 'STOPPED'],
  RUNNING: ['FAILED', 'STOPPED'],
  FAILED: [],
  STOPPED: [],
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

/** Statuses in which a container may exist and could be serving traffic. */
export function isServing(status: DeploymentStatus): boolean {
  return status === 'RUNNING';
}
