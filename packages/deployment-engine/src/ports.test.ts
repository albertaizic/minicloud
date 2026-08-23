import { describe, it, expect } from 'vitest';
import * as net from 'node:net';
import { isPortInRange, allocatePort, canBind } from './ports.js';

describe('port allocation', () => {
  it('validates range membership', () => {
    const opts = { start: 31000, end: 31005 };
    expect(isPortInRange(31000, opts)).toBe(true);
    expect(isPortInRange(31005, opts)).toBe(true);
    expect(isPortInRange(30999, opts)).toBe(false);
    expect(isPortInRange(31006, opts)).toBe(false);
    expect(isPortInRange(31000.5, opts)).toBe(false);
  });

  it('allocates a bindable port', async () => {
    const port = await allocatePort({ start: 39000, end: 39100 });
    expect(port).toBeGreaterThanOrEqual(39000);
    expect(port).toBeLessThanOrEqual(39100);
  });

  it('skips occupied ports', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(39050, r));
    try {
      for (let i = 0; i < 10; i++) {
        const port = await allocatePort({ start: 39045, end: 39055 }, 20);
        expect(port).not.toBe(39050);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('throws when the whole range is exhausted', async () => {
    const servers = await Promise.all(
      [39200, 39201].map(
        (p) =>
          new Promise<import('node:net').Server>((r) => {
            const s = net.createServer();
            s.listen(p, () => r(s));
          }),
      ),
    );
    try {
      await expect(canBind(39200)).resolves.toBe(false);
      await expect(allocatePort({ start: 39200, end: 39201 }, 4)).rejects.toThrow(/No available host port/);
    } finally {
      servers.forEach((s) => s.close());
    }
  });

  it('rejects inverted ranges', async () => {
    await expect(allocatePort({ start: 100, end: 99 })).rejects.toThrow(/Invalid port range/);
  });
});
