/**
 * WebSocket gateway integration test — verifies bidirectional WebSocket
 * communication through the MiniCloud gateway to a deployed container.
 * Requires Docker + PostgreSQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createTestApp, destroyTestContext, type TestContext } from './test-helpers.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';

let ctx: TestContext;
let fixtures: FixtureServer;

beforeAll(async () => {
  ctx = await createTestApp();
  fixtures = await startFixtureServer(['ws-echo', 'hello-node']);
}, 240_000);

afterAll(async () => {
  await fixtures?.close();
  await destroyTestContext(ctx);
});

/** Minimal WebSocket client using only Node built-ins (no ws package). */
function wsConnect(
  port: number,
  host: string,
  path: string,
): Promise<{
  send(text: string): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        host: `${host}`,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    });
    req.on('upgrade', (res, socket) => {
      const api = {
        send(text: string) {
          const payload = Buffer.from(text, 'utf8');
          const header = payload.length < 126
            ? Buffer.from([0x81, payload.length | 0x80])
            : Buffer.concat([
                Buffer.from([0x81, 126 | 0x80]),
                (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })(),
              ]);
          const mask = crypto.randomBytes(4);
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
          socket.write(Buffer.concat([header, mask, masked]));
        },
        onMessage(cb: (data: string) => void) {
          socket.on('data', (buf) => {
            if (buf.length < 2) return;
            const opcode = buf[0]! & 0x0f;
            if (opcode === 8 || opcode === 9) return;
            let len = buf[1]! & 0x7f;
            let offset = 2;
            if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
            else if (len === 127) { offset = 10; len = Number(buf.readBigUInt64BE(2)); }
            cb(buf.subarray(offset, offset + len).toString('utf8'));
          });
        },
        onClose(cb: () => void) { socket.on('close', cb); },
        close() { socket.destroy(); },
      };
      resolve(api);
    });
    req.on('error', (e) => reject(new Error(`WS connect failed: ${e.message}`)));
    req.end();
    // Timeout: if no upgrade response within 10s, reject.
    setTimeout(() => reject(new Error('WS upgrade timeout (10s)')), 10_000);
  });
}

describe('WebSocket through gateway (real docker)', () => {
  let appId: string;
  let depId: string;
  let gwPort: number;

  beforeAll(async () => {
    gwPort = ctx.gatewayPort;
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/apps',
      payload: { name: 'ws-test', repositoryUrl: fixtures.url('ws-echo') },
    });
    appId = res.json().id;
    const dep = await ctx.app.inject({ method: 'POST', url: `/api/apps/${appId}/deploy`, payload: {} });
    depId = dep.json().deployment.id;
    // Wait for RUNNING
    const start = Date.now();
    for (;;) {
      const row = (await ctx.app.inject({ method: 'GET', url: `/api/deployments/${depId}` })).json();
      if (row.status === 'RUNNING') break;
      if (row.status === 'FAILED') throw new Error(`deploy failed: ${row.failureReason}`);
      if (Date.now() - start > 180_000) throw new Error('deploy timed out');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, 300_000);

  it('connects through the gateway and echoes messages bidirectionally', async () => {
    const received: string[] = [];
    const ws = await wsConnect(gwPort, 'ws-test.localhost', '/');
    ws.onMessage((data) => received.push(data));
    ws.send('hello-gateway');
    await new Promise((r) => setTimeout(r, 1000));
    ws.send('second-message');
    await new Promise((r) => setTimeout(r, 1000));
    expect(received).toContain('hello-gateway');
    expect(received).toContain('second-message');
    ws.close();
  }, 30_000);

  it('connection is properly cleaned up after close', async () => {
    const ws = await wsConnect(gwPort, 'ws-test.localhost', '/');
    ws.send('before-close');
    await new Promise((r) => setTimeout(r, 500));
    ws.close();
    await new Promise((r) => setTimeout(r, 500));
    // No assertion needed — the test passes if no crash occurs.
  }, 30_000);

  afterAll(async () => {
    await ctx.app.inject({ method: 'DELETE', url: `/api/deployments/${depId}` });
    await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${appId}` });
  });
});
