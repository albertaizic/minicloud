// Test fixture: serves the content of version.txt so integration tests can
// observe WHICH code revision is running (used for rollback scenarios).
const http = require('node:http');
const fs = require('node:fs');
const version = fs.readFileSync(`${__dirname}/version.txt`, 'utf8').trim();

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version }));
    return;
  }
  if (req.url === '/version') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${version}\n`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`rev-app ${version}\n`);
});

server.listen(process.env.PORT || 3000, () => console.log(`rev-app ${version} listening`));
