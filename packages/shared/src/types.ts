import type { DeploymentStatus } from './deployment-status.js';

export interface Application {
  id: string;
  name: string;
  repositoryUrl: string;
  createdAt: string; // ISO timestamp
}

export interface Deployment {
  id: string;
  applicationId: string;
  commitSha: string | null;
  status: DeploymentStatus;
  imageTag: string | null;
  containerId: string | null;
  containerName: string | null;
  hostPort: number | null;
  containerPort: number | null;
  healthPath: string | null;
  failureReason: string | null;
  exitCode: number | null;
  restartCount: number;
  createdAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

/** A single log line produced by a deployment (build output or container logs). */
export interface LogLine {
  deploymentId: string;
  source: 'build' | 'container' | 'system';
  stream: 'stdout' | 'stderr';
  message: string;
  timestamp: string;
}

export interface HealthCheckConfig {
  path: string;
  port: number;
  timeoutSeconds: number;
  intervalSeconds: number;
}

/** Labels applied to every container MiniCloud manages. */
export const MINICLOUD_LABELS = {
  managed: 'minicloud.managed',
  app: 'minicloud.app',
  deployment: 'minicloud.deployment',
} as const;

export const MANAGED_LABEL_FILTER = `${MINICLOUD_LABELS.managed}=true`;
