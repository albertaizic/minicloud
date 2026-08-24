// Test fixture: allocates memory far beyond a small cgroup limit so that the
// kernel OOM-kills the container when MiniCloud's memory limit is applied.
const http = require('node:http');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.url === '/explode') {
    // Allocate 256 MB in 16 MB Buffer chunks (off-heap, so V8 flags don't
    // intervene; the cgroup limit is what stops it).
    const chunks = [];
    for (let i = 0; i < 16; i++) chunks.push(Buffer.alloc(16 * 1024 * 1024, 1));
    res.end(`allocated ${chunks.length * 16} MB`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('memory-hog up\n');
});

server.listen(3000, () => console.log('memory-hog listening on 3000'));

// Explode shortly after the health check passes so the pipeline reaches
// RUNNING and the crash monitor (not the health check) observes the OOM.
setTimeout(() => {
  const chunks = [];
  for (let i = 0; i < 32; i++) chunks.push(Buffer.alloc(16 * 1024 * 1024, 1));
}, 4000);
