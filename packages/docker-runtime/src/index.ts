// DockerRuntime: a thin, typed facade over dockerode used by the deployment engine.
// Security posture: no privileged containers, no host mounts, no docker socket
// exposed to managed containers. All identifiers passed to Docker are generated
// internally (uuids), never interpolated into shell strings.
import Dockerode from 'dockerode';
import type { LogLine } from '@minicloud/shared';

export interface ContainerSummary {
  id: string;
  names: string[];
  labels: Record<string, string>;
  state: string; // created | running | paused | restarting | removing | exited | dead
  exitCode?: number;
  hostPort?: number;
}

export interface BuildOptions {
  contextDir: string;
  tag: string;
  onOutput: (chunk: string) => void;
}

export class DockerUnavailableError extends Error {
  constructor(override readonly cause: unknown) {
    super('Docker daemon is unavailable. Is Docker running?');
    this.name = 'DockerUnavailableError';
  }
}

function wrapDockerError(err: unknown): Error {
  // dockerode surfaces daemon connection failures as ENOENT/EACCES/ECONNREFUSED codes.
  const code = (err as { code?: string })?.code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ECONNREFUSED') {
    return new DockerUnavailableError(err);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export interface ContainerResourceLimits {
  /** Docker memory limit in bytes. */
  memoryBytes?: number;
  /** CPU quota as fractional CPUs (Docker --cpus equivalent). */
  cpus?: number;
}

export interface StartContainerOptions {
  image: string;
  name: string;
  appLabel: string;
  deploymentLabel: string;
  containerPort: number;
  hostPort: number;
  env?: Record<string, string>;
  limits?: ContainerResourceLimits;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
}


/**
 * Pure docker-stats parser (unit-testable). CPU% follows the docker CLI
 * formula; memory usage subtracts cache (cgroup v1) / inactive_file (cgroup
 * v2) exactly like `docker stats`.
 */
export function parseContainerStats(
  raw: Dockerode.ContainerStats,
): ContainerStats {
  const cpuDelta =
    Number(raw.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    Number(raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    Number(raw.cpu_stats?.system_cpu_usage ?? 0) -
    Number(raw.precpu_stats?.system_cpu_usage ?? 0);
  const onlineCpus =
    raw.cpu_stats?.online_cpus ?? raw.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 0;
  const cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * onlineCpus * 100 : 0;
  const m = raw.memory_stats ?? {};
  const mstats = (m.stats ?? {}) as Record<string, number | undefined>;
  const cache = mstats.cache ?? mstats.inactive_file ?? 0;
  const used = Math.max(0, Number(m.usage ?? 0) - Number(cache ?? 0));
  const limit = Number(m.limit ?? 0);
  return {
    cpuPercent: Math.round(cpuPercent * 100) / 100,
    memoryUsedBytes: used,
    memoryLimitBytes: limit,
    memoryPercent: limit > 0 ? Math.round((used / limit) * 10000) / 100 : 0,
  };
}

export interface BuildResult {
  imageId: string;
}

export class DockerRuntime {
  private readonly docker: Dockerode;

  constructor(opts?: { socketPath?: string }) {
    this.docker = new Dockerode(
      opts?.socketPath ? { socketPath: opts.socketPath } : {},
    );
  }

  async ping(): Promise<void> {
    try {
      await this.docker.ping();
    } catch (err) {
      throw new DockerUnavailableError(err);
    }
  }

  /**
   * Build an image from a build context directory. Streams demultiplexed JSON
   * progress lines to `onOutput`. Throws with the collected error output when
   * the daemon reports an unsuccessful build.
   */
  async build(opts: BuildOptions): Promise<BuildResult> {
    let stream: NodeJS.ReadableStream;
    try {
      stream = await this.docker.buildImage(
        { src: ['.' ], context: opts.contextDir },
        { t: opts.tag, rm: true, forcerm: true },
      );
    } catch (err) {
      throw wrapDockerError(err);
    }

    let lastErrors = '';
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          if (err) reject(wrapDockerError(err));
          else if (lastErrors.trim()) {
            reject(new Error(normalizeBuildError(lastErrors)));
          } else resolve();
        },
        (event: { stream?: string; errorDetail?: { message?: string }; error?: string }) => {
          if (event.stream) opts.onOutput(event.stream);
          if (event.error || event.errorDetail?.message) {
            lastErrors += (event.error ?? '') + (event.errorDetail?.message ?? '') + '\n';
          }
        },
      );
    });

    const image = this.docker.getImage(opts.tag);
    const inspect = await image.inspect().catch(() => null);
    return { imageId: inspect?.Id ?? opts.tag };
  }

  /** Start a managed container with MiniCloud labels and a port binding. */
  async startManagedContainer(o: StartContainerOptions): Promise<{ id: string }> {
    try {
      const container = await this.docker.createContainer({
        Image: o.image,
        name: o.name,
        Labels: {
          'minicloud.managed': 'true',
          'minicloud.app': o.appLabel,
          'minicloud.deployment': o.deploymentLabel,
        },
        Env: Object.entries(o.env ?? {}).map(([k, v]) => `${k}=${v}`),
        ExposedPorts: { [`${o.containerPort}/tcp`]: {} },
        HostConfig: {
          PortBindings: {
            [`${o.containerPort}/tcp`]: [{ HostPort: String(o.hostPort) }],
          },
          // Resource limits (cgroups). Memory is in bytes; MemorySwap == Memory
          // disables swap so the cap is hard (default would allow 2x in swap).
          // NanoCpus encodes --cpus as CPUs * 1e9. Omitted entirely when unset.
          ...(o.limits?.memoryBytes
            ? { Memory: o.limits.memoryBytes, MemorySwap: o.limits.memoryBytes }
            : {}),
          ...(o.limits?.cpus ? { NanoCpus: Math.round(o.limits.cpus * 1e9) } : {}),
          Privileged: false,
          RestartPolicy: { Name: 'no' },
          // Deliberately no Binds: user containers never receive host mounts.
        },
      });
      await container.start();
      return { id: container.id };
    } catch (err) {
      throw wrapDockerError(err);
    }
  }

  async listManagedContainers(): Promise<ContainerSummary[]> {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: ['minicloud.managed=true'] },
      });
      return containers.map((c) => {
        const port = c.Ports.find((p) => p.Type === 'tcp' && p.PublicPort !== undefined);
        return {
          id: c.Id,
          names: c.Names,
          labels: c.Labels,
          state: c.State,
          hostPort: port?.PublicPort,
        };
      });
    } catch (err) {
      throw wrapDockerError(err);
    }
  }

  async getContainerState(id: string): Promise<{ running: boolean; exitCode: number | null } | null> {
    try {
      const container = this.docker.getContainer(id);
      const info = await container.inspect();
      return {
        running: info.State.Running,
        exitCode: info.State.Running ? null : (info.State.ExitCode ?? null),
      };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return null; // container removed / never existed
      throw wrapDockerError(err);
    }
  }

  /** Raw subset of `docker inspect` needed by tests and diagnostics. */
  async inspectContainer(id: string): Promise<{
    env: string[];
    state: { running: boolean; exitCode: number | null; oomKilled: boolean };
    limits: { memoryBytes: number | null; memorySwapBytes: number | null; nanoCpus: number | null };
  } | null> {
    try {
      const info = await this.docker.getContainer(id).inspect();
      return {
        env: info.Config?.Env ?? [],
        state: {
          running: info.State.Running,
          exitCode: info.State.Running ? null : (info.State.ExitCode ?? null),
          oomKilled: Boolean(info.State.OOMKilled),
        },
        limits: {
          memoryBytes: info.HostConfig?.Memory ?? null,
          memorySwapBytes: info.HostConfig?.MemorySwap ?? null,
          nanoCpus: info.HostConfig?.NanoCpus ?? null,
        },
      };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return null;
      throw wrapDockerError(err);
    }
  }

  async stop(id: string, timeoutSeconds = 10): Promise<boolean> {
    try {
      const container = this.docker.getContainer(id);
      await container.stop({ t: timeoutSeconds });
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 304) return false; // gone or already stopped
      throw wrapDockerError(err);
    }
  }

  async remove(id: string, force = false): Promise<boolean> {
    try {
      await this.docker.getContainer(id).remove({ force });
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return false;
      throw wrapDockerError(err);
    }
  }

  /**
   * Follow container logs. Returns a cancel function. Lines are delivered via
   * callback after docker multiplex demuxing.
   */
  followLogs(
    id: string,
    onLine: (line: Pick<LogLine, 'message' | 'stream'>) => void,
  ): () => void {
    let cancelled = false;
    let logStream: NodeJS.ReadableStream | null = null;

    void (async () => {
      try {
        logStream = await this.docker.getContainer(id).logs({
          follow: true,
          stdout: true,
          stderr: true,
          tail: 200,
          timestamps: false,
        });
      } catch {
        return; // container disappeared before attach; monitor handles state
      }
      if (cancelled) {
        (logStream as any)?.destroy?.();
        return;
      }
      this.docker.modem.demuxStream(logStream, {
        write(chunk: Buffer) {
          for (const line of chunk.toString('utf8').split(/\r?\n/)) {
            if (line.length > 0) onLine({ message: line, stream: 'stdout' });
          }
        },
      } as NodeJS.WritableStream, {
        write(chunk: Buffer) {
          for (const line of chunk.toString('utf8').split(/\r?\n/)) {
            if (line.length > 0) onLine({ message: line, stream: 'stderr' });
          }
        },
      } as NodeJS.WritableStream);
    })();

    return () => {
      cancelled = true;
      (logStream as unknown as { destroy?: () => void })?.destroy?.();
    };
  }

  /** Fetch recent logs as plain text (bounded). */
  async recentLogs(id: string, tail = 500): Promise<string> {
    try {
      const buf = await this.docker.getContainer(id).logs({
        follow: false,
        stdout: true,
        stderr: true,
        tail,
      });
      // Demultiplex docker's stream framing when present.
      if (Buffer.isBuffer(buf)) return stripDmux(buf);
      return String(buf);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return '';
      throw wrapDockerError(err);
    }
  }

  /** Check whether a TCP port is reachable inside the container via HTTP later; here raw TCP probe helper unused. */
  async imageExists(tag: string): Promise<boolean> {
    try {
      await this.docker.getImage(tag).inspect();
      return true;
    } catch {
      return false;
    }
  }

  async stats(id: string): Promise<ContainerStats | null> {
    let raw: Dockerode.ContainerStats;
    try {
      raw = (await this.docker.getContainer(id).stats({ stream: false })) as Dockerode.ContainerStats;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return null;
      throw wrapDockerError(err);
    }
    return parseContainerStats(raw);
  }

  /** Remove an image by tag. Returns false when it does not exist. */
  async removeImage(tag: string): Promise<boolean> {
    try {
      await this.docker.getImage(tag).remove();
      return true;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return false;
      throw wrapDockerError(err);
    }
  }

  /** All locally stored MiniCloud deployment images (minicloud/app-* tags). */
  async listMiniCloudImages(): Promise<{ id: string; tags: string[] }[]> {
    try {
      const images = await this.docker.listImages({
        filters: { reference: ['minicloud/app-*'] },
      });
      return images.map((i) => ({ id: i.Id, tags: i.RepoTags ?? [] }));
    } catch (err) {
      throw wrapDockerError(err);
    }
  }
}

/** Remove docker multiplex header bytes (8-byte frames) if present. */
function stripDmux(buf: Buffer): string {
  // Heuristic: raw non-tty logs begin with frame headers. If first byte is 0 or 1 and bytes 4..8 are zero-ish, demux.
  let out = '';
  let i = 0;
  const looksFramed =
    buf.length > 8 && (buf[0] === 0 || buf[0] === 1 || buf[0] === 2) &&
    buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return buf.toString('utf8');
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out += buf.subarray(i + 8, Math.min(i + 8 + len, buf.length)).toString('utf8');
    i += 8 + len;
  }
  return out.replace(/\r?\n$/, '');
}

function normalizeBuildError(raw: string): string {
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const meaningful = lines.filter((l) => !/^#?\d* *\d+\.\d+/.test(l)).slice(-10);
  return `Docker build failed:\n${meaningful.join('\n').slice(0, 2000)}`;
}
