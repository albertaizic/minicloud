// Unit tests for the pure docker-stats parser.
import { describe, it, expect } from 'vitest';
import { parseContainerStats } from './index.js';

function stats(overrides: Record<string, unknown> = {}): Parameters<typeof parseContainerStats>[0] {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000, percpu_usage: [1, 2, 3, 4] },
      system_cpu_usage: 20_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_500_000_000 },
      system_cpu_usage: 19_000_000_000,
    },
    memory_stats: { usage: 300 * 1024 * 1024, limit: 1024 * 1024 * 1024, stats: { cache: 50 * 1024 * 1024 } },
    ...overrides,
  } as unknown as Parameters<typeof parseContainerStats>[0];
}

describe('parseContainerStats', () => {
  it('computes CPU percent like docker CLI', () => {
    // cpuDelta = 500ms CPU ns, systemDelta = 1000ms * 4 cpus -> (0.5/1)*4*100 = 200%? No:
    // (500e6 / 1000e6) * 4 * 100 = 200 -> that is 2.0 CPUs of 4 -> docker would show 200%? No:
    // docker: (0.5e9/1e9)*4*100 = 200.0? Actually (cpu_delta/system_delta)*online_cpus*100
    // = (0.5 * 4) * 100 = 200 -> hmm that's 2 CPUs worth = 200%. Correct per formula.
    const s = parseContainerStats(stats());
    expect(s.cpuPercent).toBe(200);
  });

  it('subtracts cache (cgroup v1) from memory usage', () => {
    const s = parseContainerStats(stats());
    expect(s.memoryUsedBytes).toBe(250 * 1024 * 1024);
    expect(s.memoryPercent).toBeCloseTo((250 / 1024) * 100, 1);
  });

  it('subtracts inactive_file on cgroup v2', () => {
    const s = parseContainerStats(stats({
      memory_stats: { usage: 300 * 1024 * 1024, limit: 512 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
    }));
    expect(s.memoryUsedBytes).toBe(200 * 1024 * 1024);
    expect(s.memoryLimitBytes).toBe(512 * 1024 * 1024);
  });

  it('returns zeros instead of NaN when the daemon reports no deltas', () => {
    const s = parseContainerStats(stats({
      cpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 0, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 0 },
    }));
    expect(s.cpuPercent).toBe(0);
    expect(Number.isNaN(s.cpuPercent)).toBe(false);
  });

  it('clamps negative usage to zero', () => {
    const s = parseContainerStats(stats({
      memory_stats: { usage: 10, limit: 100, stats: { cache: 50 } },
    }));
    expect(s.memoryUsedBytes).toBe(0);
  });
});
