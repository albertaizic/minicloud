// MiniCloud Gateway: the in-process HTTP reverse proxy that gives every
// application a stable URL (<slug>.localhost:<port>) while deployment
// containers come and go on ephemeral ports.
//
// Security posture:
//  - Routing decisions come ONLY from the route table, which the deployment
//    engine fills from MiniCloud-managed deployment state. No request input
//    ever selects an upstream host:port (no SSRF surface).
//  - Inbound X-Forwarded-* headers are stripped and re-set from the actual
//    connection, so clients cannot spoof proxy chains.
//  - Hop-by-hop headers are stripped in both directions (also covers the
//    request-smuggling-relevant headers: connection-named headers are dropped).
//  - Bodies are streamed, never buffered.
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { performance } from 'node:perf_hooks';

export interface GatewayRoute {
  deploymentId: string;
  host: string;
  port: number;
  activeSince: Date;
}

export interface RouteStats {
  requests: number;
  active: number;
  ok2xx: number;
  redirect3xx: number;
  client4xx: number;
  server5xx: number;
  latencyTotalMs: number;
}

/** Hop-by-hop headers (RFC 7230 §6.1) — stripped in both proxy directions. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Parse a Host header into a route key, or null when it is not a gateway host.
 * Route keys are dot-separated labels: `app.localhost` -> `app` (the
 * application's primary public service) and `api.app.localhost` -> `api.app`
 * (a specific public service). Max three labels; every label is validated.
 */
export function slugFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().split(':')[0]!;
  if (!host.endsWith('.localhost')) return null;
  const key = host.slice(0, -'.localhost'.length);
  const labels = key.split('.');
  if (labels.length < 1 || labels.length > 3) return null;
  return labels.every((l) => SLUG_RE.test(l)) ? key : null;
}

function emptyStats(): RouteStats {
  return { requests: 0, active: 0, ok2xx: 0, redirect3xx: 0, client4xx: 0, server5xx: 0, latencyTotalMs: 0 };
}

function stripHopByHop(headers: IncomingMessage['headers'], extra: Set<string> = new Set()): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  const dropped = new Set([...HOP_BY_HOP, ...extra]);
  for (const [name, value] of Object.entries(headers)) {
    if (dropped.has(name.toLowerCase())) continue;
    // Drop connection-named headers listed in the Connection header itself
    // (request-smuggling hardening: anything the hop declared is hop-scoped).
    out[name] = value;
  }
  return out;
}

function connectionNamedHeaders(msg: IncomingMessage | http.IncomingMessage): Set<string> {
  const named = new Set<string>();
  const raw = msg.headers.connection;
  if (raw) {
    for (const token of String(raw).split(',')) {
      const name = token.trim().toLowerCase();
      if (name) named.add(name);
    }
  }
  return named;
}

export class Gateway {
  private readonly routes = new Map<string, GatewayRoute>();
  private readonly stats = new Map<string, RouteStats>();
  private readonly failureStreak = new Map<string, true>();
  private server: http.Server | null = null;
  private port = 0;
  private host = '127.0.0.1';

  /** Invoked once per consecutive upstream failure streak (for events). */
  onUpstreamError: ((slug: string, err: Error) => void) | null = null;

  get gatewayPort(): number {
    return this.port;
  }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    if (this.server) return;
    this.port = port;
    this.host = host;
    this.server = http.createServer((req, res) => void this.handle(req, res));
    // WebSocket / upgrade support: pipe raw sockets after a successful
    // upstream upgrade handshake.
    this.server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head));
    this.server.on('clientError', (err, socket) => {
      if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    // Port 0 asks the OS for a free port; reflect the assigned one back.
    const addr = this.server.address();
    if (addr && typeof addr === 'object') this.port = addr.port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  /** Point a slug at an upstream, or remove the route when upstream is null. */
  setRoute(slug: string, upstream: { deploymentId: string; host: string; port: number } | null): void {
    if (!upstream) {
      this.routes.delete(slug);
      return;
    }
    this.routes.set(slug, {
      deploymentId: upstream.deploymentId,
      host: upstream.host,
      port: upstream.port,
      activeSince: this.routes.get(slug)?.activeSince ?? new Date(),
    });
    // New upstream: reset the failure streak so the next error is reported.
    this.failureStreak.delete(slug);
  }

  getRoute(slug: string): (GatewayRoute & { url: string }) | null {
    const r = this.routes.get(slug);
    return r ? { ...r, url: this.urlFor(slug) } : null;
  }

  urlFor(slug: string): string {
    return `http://${slug}.localhost:${this.port}`;
  }

  routeSnapshot(): Array<{ slug: string } & GatewayRoute & { url: string; stats: RouteStats }> {
    return [...this.routes.entries()].map(([slug, r]) => ({
      slug,
      ...r,
      url: this.urlFor(slug),
      stats: this.statsFor(slug),
    }));
  }

  activeRequests(slug: string): number {
    return this.stats.get(slug)?.active ?? 0;
  }

  private statsFor(slug: string): RouteStats {
    let s = this.stats.get(slug);
    if (!s) {
      s = emptyStats();
      this.stats.set(slug, s);
    }
    return s;
  }

  /**
   * End-to-end verification through the gateway itself (not the container
   * directly): proves the route table actually serves the slug AND — when
   * `opts.expectedDeploymentId` is supplied — that the route table points at
   * the intended deployment. Without the identity check, a healthy 200 from a
   * stale upstream would pass; the platform must verify its own routing
   * target without requiring applications to expose MiniCloud-specific
   * version strings (see #9 of the rollback correctness brief).
   */
  async verifyRoute(
    slug: string,
    path: string,
    opts: { expectedDeploymentId?: string; attempts?: number; timeoutMs?: number } = {},
  ): Promise<boolean> {
    const attempts = opts.attempts ?? 3;
    const timeoutMs = opts.timeoutMs ?? 4000;
    const expected = opts.expectedDeploymentId ?? null;
    for (let i = 0; i < attempts; i++) {
      if (expected) {
        // Identity-strong path: introspect the route table through the
        // in-process admin endpoint. The route's deploymentId MUST equal the
        // intended deployment; otherwise the gateway is pointing at a
        // different upstream than the engine asked for.
        const actual = await this.introspectRouteDeploymentId(slug, timeoutMs);
        if (actual === expected) {
          // Confirm the upstream is actually serving traffic (not just a stale
          // route pointing at a stopped container). Any 2xx-5xx from a real
          // upstream counts; only gateway-generated 404/502/503 mean the route
          // is not live.
          if (await this.probeLive(slug, path, timeoutMs)) return true;
        }
      } else if (await this.probeLive(slug, path, timeoutMs)) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    return false;
  }

  /** Hit the in-process admin endpoint and read the route's deploymentId. */
  private introspectRouteDeploymentId(slug: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: `/__minicloud__/route-info/${encodeURIComponent(slug)}`,
          method: 'GET',
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                deploymentId?: string | null;
              };
              resolve(body.deploymentId ?? null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /** Legacy liveness probe: any non-gateway response from the upstream. */
  private probeLive(slug: string, path: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        { host: this.host, port: this.port, path, headers: { host: `${slug}.localhost` }, timeout: timeoutMs },
        (res) => {
          const status = res.statusCode ?? 500;
          res.resume();
          resolve(status !== 404 && status !== 502 && status !== 503);
        },
      );
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  // ---- request handling ------------------------------------------------------

  private respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Admin route: introspect a route's current upstream identity. The
    // well-known path /__minicloud__/route-info/<slug> bypasses normal
    // slug routing and reports the route table for the engine's
    // identity-strong verifyRoute. The gateway is bound to localhost, so
    // this endpoint is only reachable from the API process and tests.
    if (req.url?.startsWith('/__minicloud__/route-info/')) {
      const slug = decodeURIComponent(req.url.slice('/__minicloud__/route-info/'.length).split('?')[0] ?? '');
      const route = slug ? this.routes.get(slug) : null;
      this.respond(res, route ? 200 : 404, route
        ? { slug, deploymentId: route.deploymentId, host: route.host, port: route.port, activeSince: route.activeSince.toISOString() }
        : { error: 'no route for slug', slug });
      return;
    }
    const slug = slugFromHost(req.headers.host);
    if (!slug) {
      this.respond(res, 404, { error: 'Unknown host. Applications are served at http://<app>.localhost:<gateway-port>.' });
      return;
    }
    const route = this.routes.get(slug);
    if (!route) {
      this.respond(res, 503, { error: `Application "${slug}" has no active deployment right now.` });
      return;
    }

    const stats = this.statsFor(slug);
    stats.requests++;
    stats.active++;
    const startedAt = performance.now();

    // Forwarding headers: strip inbound ones, set from the real connection.
    const headers = stripHopByHop(req.headers, connectionNamedHeaders(req));
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-proto'];
    delete headers['x-forwarded-host'];
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? 'unknown';
    headers['x-forwarded-proto'] = 'http';
    headers['x-forwarded-host'] = req.headers.host ?? `${slug}.localhost`;

    const upstream = http.request(
      { host: route.host, port: route.port, method: req.method, path: req.url, headers },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 500;
        if (status < 300) stats.ok2xx++;
        else if (status < 400) stats.redirect3xx++;
        else if (status < 500) stats.client4xx++;
        else stats.server5xx++;
        stats.latencyTotalMs += performance.now() - startedAt;
        this.failureStreak.delete(slug);

        const resHeaders = stripHopByHop(upstreamRes.headers, connectionNamedHeaders(upstreamRes));
        res.writeHead(status, resHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
      },
    );
    upstream.on('error', (err) => {
      stats.active--;
      stats.latencyTotalMs += performance.now() - startedAt;
      stats.server5xx++;
      if (!this.failureStreak.has(slug)) {
        this.failureStreak.set(slug, true);
        this.onUpstreamError?.(slug, err);
      }
      this.respond(res, 502, { error: 'Upstream container is unreachable.', deploymentId: route.deploymentId });
    });
    req.pipe(upstream);
    req.on('error', () => upstream.destroy());
    const finish = () => {
      stats.active--;
    };
    res.on('finish', finish);
    res.on('close', () => {
      if (!res.writableFinished) finish();
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const slug = slugFromHost(req.headers.host);
    const route = slug ? this.routes.get(slug) : undefined;
    if (!slug || !route) {
      socket.destroy();
      return;
    }
    const headers = stripHopByHop(req.headers, connectionNamedHeaders(req));
    const upstream = http.request({
      host: route.host,
      port: route.port,
      method: req.method,
      path: req.url,
      headers: { ...headers, upgrade: 'websocket', connection: 'Upgrade' },
    });
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      // 101 Switching Protocols responses MUST include Upgrade and Connection
      // headers (RFC 7230 §6.7). Hop-by-hop stripping applies only to normal
      // proxied responses, not to the upgrade handshake itself.
      const resHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        resHeaders[name] = value;
      }
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`];
      for (const [name, value] of Object.entries(resHeaders)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) upstreamSocket.unshift(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const cleanup = () => {
        socket.destroy();
        upstreamSocket.destroy();
      };
      socket.on('error', cleanup);
      upstreamSocket.on('error', cleanup);
      socket.on('close', cleanup);
      upstreamSocket.on('close', cleanup);
    });
    upstream.on('error', () => socket.destroy());
    upstream.end();
  }
}
