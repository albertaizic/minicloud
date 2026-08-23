// Port allocation: pick a free host port inside the configured range.
// Strategy: probe with a bind(0)-style check — we attempt to *bind* the port on
// 0.0.0.0 to verify availability, then release it immediately before Docker
// binds it. There is an unavoidable TOCTOU window between our probe and
// Docker's bind; Docker itself will fail to start the container if the port is
// taken in that window, and the deployment surfaces a clear error. Randomizing
// candidates reduces collision probability under concurrency.
import * as net from 'node:net';
import { randomInt } from 'node:crypto';

export interface PortAllocatorOptions {
  start: number;
  end: number;
}

export function isPortInRange(port: number, opts: PortAllocatorOptions): boolean {
  return Number.isInteger(port) && port >= opts.start && port <= opts.end;
}

export async function canBind(port: number): Promise<boolean> {
  return tryBind(port);
}

function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    // Omitting the host binds to the unspecified address (:: on dual-stack),
    // which conflicts with any existing IPv4 or IPv6 listener.
    server.listen({ port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Select up to `attempts` candidate ports and return the first one we can bind.
 * Throws when no port in the range is available.
 */
export async function allocatePort(opts: PortAllocatorOptions, attempts = 25): Promise<number> {
  const span = opts.end - opts.start + 1;
  if (span <= 0) throw new Error(`Invalid port range ${opts.start}..${opts.end}`);
  const tried = new Set<number>();
  const maxTries = Math.min(attempts, span);
  for (let i = 0; i < maxTries; i++) {
    let port: number;
    // After many random attempts, fall back to a sequential scan for determinism.
    if (i < maxTries - 5) {
      do {
        port = randomInt(opts.start, opts.end + 1);
      } while (tried.has(port));
    } else {
      let seq = opts.start;
      while (tried.has(seq) && seq <= opts.end) seq++;
      port = seq;
    }
    tried.add(port);
    if (await canBind(port)) return port;
  }
  throw new Error(`No available host port in range ${opts.start}..${opts.end}`);
}
