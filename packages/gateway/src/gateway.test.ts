// Unit tests for the gateway: host parsing, proxying semantics, header
// hygiene, error responses and counters. Uses real HTTP servers (no mocks for
// the proxy itself).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Gateway, slugFromHost } from './index.js';

let upstream: http.Server;
let upstreamPort = 0;
let upstreamSeenHeaders: Record<string, unknown> = {};
const gateway = new Gateway();
let gwPort = 0;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/echo-headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (req.url === '/slow') {
      setTimeout(() => {
        res.writeHead(200);
        res.end('slow-ok');
      }, 300);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-body');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamPort = (upstream.address() as AddressInfo).port;

  await gateway.start(0);
  gwPort = gateway.gatewayPort;
  gateway.setRoute('app', { deploymentId: 'dep-1', host: '127.0.0.1', port: upstreamPort });
});

afterAll(async () => {
  await gateway.stop();
  upstream.close();
});

function gwRequest(
  slugHost: string,
  path = '/',
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: gwPort, path, headers: { host: slugHost, ...extraHeaders } },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('slugFromHost', () => {
  it('parses gateway hosts and rejects everything else', () => {
    expect(slugFromHost('app.localhost:8080')).toBe('app');
    expect(slugFromHost('app.localhost')).toBe('app');
    expect(slugFromHost('My-App.localhost')).toBe('my-app');
    expect(slugFromHost('evil.com')).toBeNull();
    expect(slugFromHost('app.evil.com')).toBeNull();
    expect(slugFromHost('.localhost')).toBeNull();
    expect(slugFromHost('-app.localhost')).toBeNull();
    expect(slugFromHost(undefined)).toBeNull();
    expect(slugFromHost('a'.repeat(64) + '.localhost')).toBeNull(); // > 63 chars
  });
});

describe('gateway proxying', () => {
  it('routes a known slug to the upstream and returns its body', async () => {
    const res = await gwRequest('app.localhost');
    expect(res.status).toBe(200);
    expect(res.body).toBe('upstream-body');
  });

  it('404s unknown hosts and malformed hosts', async () => {
    expect((await gwRequest('unknown.localhost')).status).toBe(503); // known shape, no route
    expect((await gwRequest('evil.com')).status).toBe(404);
    expect((await gwRequest('app.evil.com')).status).toBe(404);
  });

  it('503s a slug whose route was removed', async () => {
    gateway.setRoute('temp', { deploymentId: 'dep-2', host: '127.0.0.1', port: upstreamPort });
    expect((await gwRequest('temp.localhost')).status).toBe(200);
    gateway.setRoute('temp', null);
    expect((await gwRequest('temp.localhost')).status).toBe(503);
  });

  it('sets forwarding headers from the real connection and strips spoofed ones', async () => {
    const res = await gwRequest('app.localhost', '/echo-headers', {
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-proto': 'https',
    });
    const headers = JSON.parse(res.body) as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('127.0.0.1'); // real client, not the spoof
    expect(headers['x-forwarded-proto']).toBe('http'); // gateway protocol
    expect(headers['x-forwarded-host']).toBe('app.localhost');
  });

  it('strips hop-by-hop headers including connection-named ones', async () => {
    const res = await gwRequest('app.localhost', '/echo-headers', {
      connection: 'X-Sneaky',
      'x-sneaky': 'smuggled',
      'x-kept': 'yes',
    });
    const headers = JSON.parse(res.body) as Record<string, string>;
    expect(headers['x-sneaky']).toBeUndefined(); // named hop-by-hop -> dropped
    expect(headers['x-kept']).toBe('yes');
  });

  it('502s when the upstream is unreachable', async () => {
    gateway.setRoute('dead', { deploymentId: 'dep-3', host: '127.0.0.1', port: 1 }); // nothing listens
    const res = await gwRequest('dead.localhost');
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error).toMatch(/unreachable/i);
  });

  it('preserves method, path and query', async () => {
    let seen = '';
    const orig = upstream;
    // reuse /echo-headers trick: path arrives via url; assert via a one-off listener
    const server = http.createServer((req, res) => {
      seen = `${req.method} ${req.url}`;
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    gateway.setRoute('method-test', { deploymentId: 'dep-4', host: '127.0.0.1', port });
    await gwRequest('method-test.localhost', '/a/b?x=1&y=2', {});
    expect(seen).toBe('GET /a/b?x=1&y=2');
    await new Promise<void>((r) => server.close(() => r()));
    void orig;
  });

  it('counts requests, statuses and active requests per slug', async () => {
    await gwRequest('app.localhost');
    await gwRequest('app.localhost', '/echo-headers');
    const snap = gateway.routeSnapshot().find((r) => r.slug === 'app')!;
    expect(snap.stats.requests).toBeGreaterThanOrEqual(3);
    expect(snap.stats.ok2xx).toBeGreaterThanOrEqual(3);
    expect(snap.stats.active).toBe(0);
    expect(snap.stats.latencyTotalMs).toBeGreaterThanOrEqual(0);
  });

  it('verifyRoute proves the route through the gateway itself', async () => {
    expect(await gateway.verifyRoute('app', '/')).toBe(true);
    expect(await gateway.verifyRoute('nope', '/')).toBe(false);
  });

  it('verifyRoute with expectedDeploymentId rejects when the route points elsewhere', async () => {
    // Route currently points at dep-1; verifying against dep-2 must fail.
    expect(await gateway.verifyRoute('app', '/', { expectedDeploymentId: 'dep-2' })).toBe(false);
    // And succeeds when the expected id matches reality.
    expect(await gateway.verifyRoute('app', '/', { expectedDeploymentId: 'dep-1' })).toBe(true);
  });

  it('verifyRoute with expectedDeploymentId fails when no route exists', async () => {
    expect(await gateway.verifyRoute('nope', '/', { expectedDeploymentId: 'dep-1' })).toBe(false);
  });

  it('route-info admin endpoint returns the route deploymentId for the engine', async () => {
    const res = await gwRequest('app.localhost', '/__minicloud__/route-info/app');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { deploymentId: string; host: string; port: number };
    expect(body.deploymentId).toBe('dep-1');
    expect(body.host).toBe('127.0.0.1');
    expect(body.port).toBe(upstreamPort);
  });

  it('route-info admin endpoint reports no route when the slug is unknown', async () => {
    const res = await gwRequest('app.localhost', '/__minicloud__/route-info/nope');
    expect(res.status).toBe(404);
  });

  it('route swap followed by verifyRoute identity check returns false until the swap matches', async () => {
    // Stale route pointing at dep-1: identity check against dep-2 fails.
    expect(await gateway.verifyRoute('app', '/', { expectedDeploymentId: 'dep-2' })).toBe(false);
    // Swap and re-verify.
    gateway.setRoute('app', { deploymentId: 'dep-2', host: '127.0.0.1', port: upstreamPort });
    expect(await gateway.verifyRoute('app', '/', { expectedDeploymentId: 'dep-2' })).toBe(true);
    // Restore for downstream assertions.
    gateway.setRoute('app', { deploymentId: 'dep-1', host: '127.0.0.1', port: upstreamPort });
  });
});
