const http = require('node:http');
const fs = require('node:fs');
const DATA = '/data/counter.json';
const VERSION = fs.readFileSync(`${__dirname}/version.txt`, 'utf8').trim();

function readCount() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')).count; } catch { return 0; }
}
function writeCount(count) {
  fs.mkdirSync('/data', { recursive: true });
  fs.writeFileSync(DATA, JSON.stringify({ count, updatedAt: new Date().toISOString() }));
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION }));
    return;
  }
  if (req.url === '/count' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count: readCount(), version: VERSION }));
    return;
  }
  if (req.url === '/increment' && req.method === 'POST') {
    const count = readCount() + 1;
    writeCount(count);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ count, version: VERSION }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`api ${VERSION}\n`);
});
server.listen(4000, () => console.log(`api ${VERSION} on 4000`));
