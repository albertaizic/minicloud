// Intentionally broken app: starts listening, then crashes after ~3s.
const http = require('node:http');
const port = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(500);
  res.end('this app is broken on purpose\n');
});

server.listen(port, () => {
  console.log(`failing-app listening on ${port}, crashing soon...`);
  setTimeout(() => {
    console.error('fatal: intentional crash (demo of MiniCloud failure detection)');
    process.exit(1);
  }, 3000);
});
