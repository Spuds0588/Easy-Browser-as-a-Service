'use strict';

/**
 * A deliberately boring "legacy CRM" stand-in served from its own origin, so
 * tests can tell host state and remote state apart.
 *
 *   node test/target-app.js [port]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');
const HELLO = 'hello from the remote browser\n';

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/' || url.pathname === '/target.html') {
    const body = fs.readFileSync(path.join(FIXTURES, 'target.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (url.pathname === '/host.html' || url.pathname === '/host-autotoken.html') {
    const raw = fs.readFileSync(path.join(FIXTURES, url.pathname.slice(1)), 'utf8');
    const body = raw
      .replaceAll('{{SERVICE_ORIGIN}}', process.env.SERVICE_ORIGIN || 'http://localhost:8080')
      .replaceAll('{{TARGET_ORIGIN}}', process.env.TARGET_ORIGIN || 'http://localhost:8081')
      .replaceAll('{{RBAS_TOKEN}}', process.env.RBAS_TOKEN || '');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
    return;
  }
  if (url.pathname === '/favicon.ico') {
    // Browsers ask for this unprompted; answering beats a console 404.
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/hello.txt') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="hello.txt"',
      'Cache-Control': 'no-store',
    });
    res.end(HELLO);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function start(port = Number(process.env.TARGET_PORT || 8081), host = process.env.BIND || '127.0.0.1') {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, host, () => resolve({ server, port, host }));
  });
}

if (require.main === module) {
  start().then(({ port }) => console.log(`[TARGET] fixture app on http://localhost:${port}/`));
}

module.exports = { start, HELLO };
