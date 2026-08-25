// Zero-dependency WebSocket echo server. Accepts any WebSocket upgrade,
// echoes text frames back, responds to pings, handles close.
const http = require('node:http');
const crypto = require('node:crypto');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ws-echo\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.on('data', (buf) => {
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    if (opcode === 8) { socket.end(); return; }
    if (opcode === 9) { socket.write(Buffer.from([0x8a, 0x00])); return; }
    let payloadLen = buf[1] & 0x7f;
    let maskOffset = 2;
    if (payloadLen === 126) { payloadLen = buf.readUInt16BE(2); maskOffset = 4; }
    else if (payloadLen === 127) { maskOffset = 10; payloadLen = Number(buf.readBigUInt64BE(2)); }
    const maskKey = buf.subarray(maskOffset, maskOffset + 4);
    const payload = buf.subarray(maskOffset + 4, maskOffset + 4 + payloadLen);
    const unmasked = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
    const header = payloadLen < 126
      ? Buffer.from([0x81, payloadLen])
      : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payloadLen); return b; })()]);
    socket.write(Buffer.concat([header, unmasked]));
  });
  socket.on('error', () => socket.destroy());
});

server.listen(process.env.PORT || 3000, () => console.log('ws-echo listening'));
