// slow-build fixture: minimal health endpoint for deployment tests.
const http = require('node:http');
let builds = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    builds++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', builds }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(process.env.PORT ?? 3000);
