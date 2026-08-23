// Minimal Node web app for MiniCloud demos.
const http = require('node:http');
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Hello from MiniCloud!\n');
});

server.listen(port, () => console.log(`hello-node listening on ${port}`));
