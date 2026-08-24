// Test fixture: passes its health check, then crashes a few seconds later —
// UNLESS MiniCloud's automatic restart marked it (MINICLOUD_RESTART_ATTEMPT),
// in which case it stays healthy. This makes "crash once from RUNNING, then
// recover" deterministic across container recreations.
const http = require('node:http');
const attempt = process.env.MINICLOUD_RESTART_ATTEMPT;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', attempt: attempt ?? null }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`crash-once attempt ${attempt ?? 'initial'}\n`);
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`crash-once listening on 3000 (attempt=${attempt ?? 'initial'})`);
  if (!attempt) {
    // First start: pass health checks, then crash so the crash monitor (not
    // the health check) observes the failure.
    setTimeout(() => {
      console.error('crash-once: crashing on purpose (initial start)');
      process.exit(1);
    }, 5000);
  }
});
