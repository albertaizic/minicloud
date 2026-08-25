const http = require('node:http');
const API_HOST = process.env.API_SERVICE_HOST || 'api';
const API_PORT = process.env.API_SERVICE_PORT || '4000';

function increment() {
  const req = http.request({ host: API_HOST, port: API_PORT, path: '/increment', method: 'POST' }, (res) => {
    res.resume();
    console.log('worker incremented ->', res.statusCode);
  });
  req.on('error', (e) => console.error('worker increment failed:', String(e)));
  req.end();
}
increment();
setInterval(increment, 15000);
console.log('worker started');
