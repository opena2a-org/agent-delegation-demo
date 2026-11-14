// Small HTTP helpers shared by the bank and the view server.

export function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req, limit) {
  const text = await readBody(req, limit);
  if (!text) return {};
  return JSON.parse(text);
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

export function bearer(req) {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(h);
  return m ? m[1] : null;
}

// State changing routes refuse a request whose Host is not this listener's
// loopback address, or whose Origin is present and is not the bank UI's own
// origin. This defends against a web page reaching the loopback bank through
// DNS rebinding or a cross site form; locality itself is the bind address.
export function hostAndOriginAllowed(req, { port, origins }) {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  return origins.includes(origin);
}

export function listen(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

export function close(server) {
  return new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}
