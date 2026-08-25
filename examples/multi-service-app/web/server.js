const http = require('node:http');
const fs = require('node:fs');
const API_HOST = process.env.API_SERVICE_HOST || 'api';
const API_PORT = process.env.API_SERVICE_PORT || '4000';
const VERSION = fs.readFileSync(`${__dirname}/version.txt`, 'utf8').trim();

function callApi(path, method) {
  return new Promise((resolve) => {
    const req = http.request({ host: API_HOST, port: API_PORT, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', (e) => resolve(JSON.stringify({ error: String(e) })));
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/increment') {
    const body = await callApi('/increment', 'POST');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: VERSION }));
    return;
  }
  if (req.url === '/') {
    const body = await callApi('/count', 'GET');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: 'web', version: VERSION, api: JSON.parse(body) }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`web ${VERSION}\n`);
});
server.listen(3000, () => console.log(`web ${VERSION} on 3000`));
