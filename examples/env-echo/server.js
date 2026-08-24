// Test fixture: echoes selected environment variables over HTTP so
// integration tests can verify that MiniCloud injects env vars and
// decrypted secrets into real containers.
const http = require('node:http');
const port = process.env.PORT || 3000;

// Only expose keys the test sets explicitly; never dump the whole env.
const ECHO_KEYS = ['DEMO_PLAIN', 'DEMO_SECRET', 'APP_MODE'];

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/env') {
    const out = {};
    for (const key of ECHO_KEYS) {
      if (process.env[key] !== undefined) out[key] = process.env[key];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('env-echo up\n');
});

server.listen(port, () => console.log(`env-echo listening on ${port}`));
